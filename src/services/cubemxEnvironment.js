"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const exec = promisify(execFile);

function failure(code, message, details = {}) {
    return Object.assign(new Error(message), {
        code,
        category: "configuration",
        retryable: false,
        details,
        likelyCause: message,
        suggestedActions: [
            "Review the CubeMX diagnostic and retained generation files. Resolve the reported issue before preparing again; do not automatically repeat a write."
        ]
    });
}
function inside(root, file) {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function readUpdater(home) {
    if (!home) return null;
    const file = path.join(home, ".stm32cubemx", "plugins", "updater", "updater.ini");
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const properties = Object.fromEntries(
        text
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .filter((line) => /^\s*(SoftwarePath|SoftVersion)\s*=/.test(line))
            .map((line) => {
                const index = line.indexOf("=");
                return [
                    line.slice(0, index).trim(),
                    line
                        .slice(index + 1)
                        .trim()
                        .replace(/^"(.*)"$/, "$1")
                ];
            })
    );
    const location = properties.SoftwarePath;
    if (!location || !path.isAbsolute(location)) return null;
    return {
        executable: /\.exe$/i.test(location) ? location : path.join(location, "STM32CubeMX.exe"),
        version: properties.SoftVersion?.match(/^(?:MX\.)?(\d+\.\d+\.\d+)(?:[-\w.]*)$/)?.[1] || "",
        source: file
    };
}
async function installation(executable, options = {}) {
    if (!path.isAbsolute(executable) || /[\r\n"]/.test(executable))
        throw failure("CUBEMX_PATH_INVALID", "Select an absolute CubeMX executable path");
    const file = await fs.realpath(executable);
    if (path.basename(file).toLowerCase() !== "stm32cubemx.exe" || !(await fs.stat(file)).isFile())
        throw failure("CUBEMX_PATH_INVALID", "Expected STM32CubeMX.exe");
    const directory = path.dirname(file);
    const java = path.join(directory, "jre", "bin", "java.exe");
    if (!(await fs.stat(java)).isFile()) throw failure("CUBEMX_JAVA_MISSING", "CubeMX bundled Java is missing");
    let version = "";
    for (const name of ["version.xml", "db/version.xml"]) {
        const xml = await fs.readFile(path.join(directory, name), "utf8").catch(() => "");
        const match = xml.match(/(?:Version|version)[^\d]{0,30}(\d+\.\d+\.\d+)/);
        if (match) {
            version = match[1];
            break;
        }
    }
    if (!version) {
        const updater = options.updater === undefined ? await readUpdater(os.homedir()) : options.updater;
        if (updater) {
            const recorded = await fs.realpath(updater.executable).catch(() => "");
            if (recorded.toLowerCase() === file.toLowerCase()) version = updater.version;
        }
    }
    const stat = await fs.stat(file);
    return { executable: file, java, version, size: stat.size, modified: stat.mtimeMs };
}
async function discover(options = {}) {
    const env = options.env || process.env;
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA, "C:\\ST"].filter(Boolean);
    const candidates = new Set();
    const home = env.USERPROFILE || env.HOME || (options.env ? "" : os.homedir());
    const updater = await readUpdater(home);
    if (updater) candidates.add(updater.executable);
    for (const candidate of options.hints || [])
        if (typeof candidate === "string" && candidate.trim()) candidates.add(candidate.trim());
    for (const root of roots) {
        candidates.add(path.join(root, "STMicroelectronics", "STM32Cube", "STM32CubeMX", "STM32CubeMX.exe"));
        candidates.add(path.join(root, "STM32CubeMX", "STM32CubeMX.exe"));
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => []))
            if (entry.isDirectory() && /^STM32CubeMX/i.test(entry.name))
                candidates.add(path.join(root, entry.name, "STM32CubeMX.exe"));
    }
    for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean))
        candidates.add(path.join(directory, "STM32CubeMX.exe"));
    const run = options.exec || exec;
    for (const key of [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
    ]) {
        const result = await run("reg.exe", ["query", key, "/s"], {
            timeout: 3000,
            windowsHide: true
        }).catch(() => ({ stdout: "" }));
        for (const section of result.stdout.split(/(?=HKEY_)/)) {
            if (!/STM32CubeMX/i.test(section)) continue;
            for (const match of section.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g))
                candidates.add(path.join(match[1].trim(), "STM32CubeMX.exe"));
        }
    }
    const installs = (
        await Promise.all([...candidates].map((candidate) => installation(candidate, { updater }).catch(() => null)))
    ).filter(Boolean);
    installs.sort(
        (a, b) =>
            b.version.localeCompare(a.version, "en", { numeric: true }) || a.executable.localeCompare(b.executable)
    );
    return installs[0] || null;
}
async function workspaceIoc(vscode, value) {
    if (!value) return "";
    const roots = vscode.workspace.workspaceFolders || [];
    const resolved = path.resolve(roots[0]?.uri.fsPath || ".", value);
    const file = await fs.realpath(resolved);
    const realRoots = await Promise.all(roots.map((root) => fs.realpath(root.uri.fsPath)));
    if (!realRoots.some((root) => inside(root, file)))
        throw failure("PATH_OUTSIDE_WORKSPACE", ".ioc must be inside a workspace");
    if (path.extname(file).toLowerCase() !== ".ioc" || !(await fs.stat(file)).isFile())
        throw failure("INVALID_FILE_TYPE", "Select an existing .ioc file");
    return file;
}
module.exports = { failure, inside, installation, discover, workspaceIoc, readUpdater };
