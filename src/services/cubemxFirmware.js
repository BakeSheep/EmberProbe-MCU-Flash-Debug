"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { XMLParser } = require("fast-xml-parser");
const { installation, workspaceIoc } = require("./cubemxEnvironment");
const { parseProperties } = require("./javaProperties");
const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
const families = "H7RS WB0 WBA WL3 F0 F1 F2 F3 F4 F7 G0 G4 H5 H7 L0 L1 L4 L5 U0 U3 U5 C0 N6 WB WL".split(" ");
function targetFamily(target) {
    const name = path.basename(String(target || "").replace(/\\/g, "/")).replace(/\.cfg$/i, "");
    if (/^stm32h7[rs]\d/i.test(name)) return "H7RS";
    return (
        families.find((family) => new RegExp("^stm32" + family + "(?:[0-9x_].*|[a-z][0-9].*)?$", "i").test(name)) || ""
    );
}
function list(value) {
    return value ? (Array.isArray(value) ? value : [value]) : [];
}
async function xml(file) {
    return parser.parse(await fs.readFile(file, "utf8"));
}
async function updaterSettings(home) {
    const directory = path.join(home, ".stm32cubemx", "plugins", "updater");
    const ini = await fs.readFile(path.join(directory, "updater.ini"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
    });
    const repository = ini.match(/^\s*RepositoryPath\s*=\s*(.+?)\s*$/m)?.[1].replace(/^"(.*)"$/, "$1");
    if (repository && !path.isAbsolute(repository)) throw new Error("Invalid CubeMX RepositoryPath");
    return { directory, repository: repository || path.join(home, "STM32Cube", "Repository") };
}
async function packageVersions(repository, family) {
    const entries = await fs.readdir(repository, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const versions = [];
    for (const entry of entries) {
        const match = entry.name.match(new RegExp("^STM32Cube_FW_" + family + "_V(\\d+\\.\\d+\\.\\d+)$", "i"));
        if (!match || !entry.isDirectory()) continue;
        const root = path.join(repository, entry.name);
        try {
            const description = (await xml(path.join(root, "package.xml"))).Package?.PackDescription;
            const release = description?.["@_Patch"] || description?.["@_Release"];
            if (release !== `FW.${family}.${match[1]}`) continue;
            if (!(await fs.stat(path.join(root, "Drivers", "CMSIS"))).isDirectory()) continue;
            if (!(await fs.stat(path.join(root, "Drivers", `STM32${family}xx_HAL_Driver`))).isDirectory()) continue;
            versions.push(match[1]);
        } catch (error) {
            if (error.code === "EACCES" || error.code === "EPERM") throw error;
            // Incomplete downloads and invalid package manifests are not installed packages.
        }
    }
    return versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}
async function availableVersions(directory, family) {
    const data = await xml(path.join(directory, "STMUpdaterDefinitions.xml")).catch(() => ({}));
    const versions = list(data.Packages?.Firmwares?.Firmware)
        .flatMap((entry) => list(entry.PackDescription))
        .map((entry) => entry["@_Patch"] || entry["@_Release"])
        .map((release) => String(release).match(new RegExp("^FW\\." + family + "\\.(\\d+\\.\\d+\\.\\d+)$"))?.[1])
        .filter(Boolean);
    return [...new Set(versions)].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}
async function inspectFirmware(config, options = {}) {
    const family = targetFamily(config.target);
    if ((options.platform || process.platform) !== "win32" || !config.cubemxPath || !family) return null;
    await (options.installation || installation)(config.cubemxPath);
    const settings = await updaterSettings(options.home || os.homedir());
    let requiredVersion = "";
    if (config.iocPath) {
        const source = await (options.resolveIoc || (async (file) => file))(config.iocPath);
        if ((await fs.stat(source)).size > 1024 * 1024) throw new Error(".ioc exceeds 1 MiB");
        const properties = parseProperties(await fs.readFile(source, "utf8"));
        const firmware = properties["ProjectManager.FirmwarePackage"]?.match(/^STM32Cube FW_(\w+) V(\d+\.\d+\.\d+)$/);
        if (!firmware || firmware[1] !== family || targetFamily(properties["Mcu.Name"]) !== family)
            throw new Error("Target and .ioc firmware family do not match");
        if (properties["ProjectManager.DefaultFWLocation"] === "false")
            throw new Error("The .ioc uses a custom firmware location; check it in CubeMX");
        requiredVersion = firmware[2];
    }
    const versions = await packageVersions(settings.repository, family);
    return {
        family,
        requiredVersion,
        versions,
        repository: settings.repository,
        installed: requiredVersion ? versions.includes(requiredVersion) : versions.length > 0,
        available: requiredVersion ? [requiredVersion] : await availableVersions(settings.directory, family)
    };
}

// This is an interactive installer, separate from the Bridge's quiet generation runner.
// Never accept licenses, load/save an ioc, or generate code from this script.
async function launchInstaller(tool, family, version, options = {}) {
    if (!families.includes(family) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid firmware package");
    const directory = await fs.mkdtemp(path.join(options.temp || os.tmpdir(), "emberprobe-cubemx-install-"));
    const script = path.join(directory, "install.txt");
    const cleanup = () => fs.rm(directory, { recursive: true, force: true });
    try {
        await fs.writeFile(
            script,
            `swmgr refresh\nswmgr install stm32cube_${family.toLowerCase()}_${version} ask\n`,
            "utf8"
        );
        const child = (options.spawn || spawn)(tool.java, ["-jar", tool.executable, "-s", script], {
            cwd: path.dirname(tool.executable),
            shell: false,
            windowsHide: true,
            stdio: "ignore"
        });
        child.once("close", () => {
            cleanup().catch(() => {});
            options.closed?.();
        });
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        child.unref();
    } catch (error) {
        await cleanup();
        throw error;
    }
}

class CubeMxFirmware {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.t = options.t;
        this.changed = options.changed;
        this.result = null;
        this.error = "";
        this.revision = 0;
        this.opening = false;
        this.inspect = options.inspect || inspectFirmware;
        this.launch = options.launch || launchInstaller;
        this.installation = options.installation || installation;
    }
    config() {
        return {
            target: this.context.workspaceState.get("mcu.mcuCore", ""),
            cubemxPath: this.vscode.workspace.getConfiguration("emberprobe").get("cubemxPath", ""),
            iocPath: this.context.workspaceState.get("mcu.iocPath", "")
        };
    }
    async refresh() {
        const revision = ++this.revision;
        let result = null;
        let error = "";
        try {
            result = await this.inspect(this.config(), { resolveIoc: (file) => workspaceIoc(this.vscode, file) });
        } catch (reason) {
            error = String(reason.message);
        }
        if (revision === this.revision) {
            this.result = result;
            this.error = error;
        }
    }
    async install() {
        if (this.opening) return;
        this.opening = true;
        try {
            const original = JSON.stringify(this.config());
            await this.refresh();
            const result = this.result;
            if (!result || result.installed) {
                if (this.error)
                    await this.vscode.window.showWarningMessage(this.t("cubemx.firmwareUnknown") + ": " + this.error);
                return;
            }
            let version = result.requiredVersion;
            if (!version && result.available.length) {
                const choice = await this.vscode.window.showQuickPick(
                    result.available.map((value) => ({
                        label: `STM32Cube ${result.family} V${value}`,
                        value
                    })),
                    { placeHolder: this.t("cubemx.chooseFirmware") }
                );
                version = choice?.value;
            } else if (!version) {
                version = await this.vscode.window.showInputBox({
                    prompt: this.t("cubemx.firmwareVersion") + ` (STM32Cube ${result.family})`,
                    placeHolder: "1.13.0",
                    validateInput: (value) => (/^\d+\.\d+\.\d+$/.test(value) ? null : this.t("cubemx.firmwareVersion"))
                });
            }
            if (!version || original !== JSON.stringify(this.config())) return;
            const tool = await this.installation(this.config().cubemxPath);
            await this.launch(tool, result.family, version, { closed: () => this.changed() });
            await this.vscode.window.showInformationMessage(this.t("cubemx.firmwareOpened"));
        } finally {
            this.opening = false;
            this.changed();
        }
    }
}
module.exports = {
    targetFamily,
    updaterSettings,
    packageVersions,
    availableVersions,
    inspectFirmware,
    launchInstaller,
    CubeMxFirmware
};
