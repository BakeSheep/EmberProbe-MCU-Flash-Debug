"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { failure, inside, supportedPlatform } = require("./cubemxEnvironment");
const exec = promisify(execFile);
const VERSION = "(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)";
const BUNDLE_NAME = "stm32cubemx-application";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function launcherPattern(platform) {
    return new RegExp(`^stm32cubemx2(?:-${VERSION})?${platform === "win32" ? "\\.exe" : ""}$`, "i");
}

async function installation(executable, options = {}) {
    const platform = options.platform || process.platform;
    if (!supportedPlatform(platform))
        throw failure("CUBEMX2_PLATFORM_UNSUPPORTED", "CubeMX2 path detection supports Windows and Linux");
    if (typeof executable !== "string" || !path.isAbsolute(executable) || /[\r\n"\0]/.test(executable))
        throw failure("CUBEMX2_PATH_INVALID", "Select an absolute CubeMX2 launcher path");
    const file = await fs.realpath(executable);
    const match = path.basename(file).match(launcherPattern(platform));
    const stat = await fs.stat(file);
    if (!match || !stat.isFile())
        throw failure("CUBEMX2_PATH_INVALID", "Expected a stm32cubemx2 launcher, optionally followed by its version");
    if (platform === "linux") await fs.access(file, fs.constants.X_OK);
    return { executable: file, platform, version: match[1] || "", size: stat.size, modified: stat.mtimeMs };
}

async function readJson(file) {
    let handle;
    try {
        handle = await fs.open(file, "r");
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > stat.size) return null;
        return JSON.parse(
            bytes
                .subarray(0, bytesRead)
                .toString("utf8")
                .replace(/^\uFEFF/, "")
        );
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

// The standalone installer registers its application bundle under <install>/resources/<name>/<version>.
// Validate that registration as data and resolve the matching launcher without executing its bundle commands.
async function registeredInstallation(directory, platform) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || /[\r\n"\0]/.test(directory)) return null;
    const manifest = await readJson(path.join(directory, "CubeBundle.json"));
    if (
        manifest?.name !== BUNDLE_NAME ||
        typeof manifest.version !== "string" ||
        !new RegExp(`^${VERSION}$`).test(manifest.version) ||
        path.basename(directory) !== manifest.version ||
        path.basename(path.dirname(directory)) !== BUNDLE_NAME ||
        path.basename(path.resolve(directory, "../..")) !== "resources"
    )
        return null;
    const root = path.resolve(directory, "../../..");
    const suffix = platform === "win32" ? ".exe" : "";
    // An installer may keep only an older versioned launcher in its root; the bundle's own application
    // executable opens the same CubeMX2 version.
    for (const file of [
        path.join(root, `stm32cubemx2-${manifest.version}${suffix}`),
        path.join(root, `STM32CubeMX2${suffix}`),
        path.join(directory, "dist", `stm32cubemx2${suffix}`)
    ]) {
        const tool = await installation(file, { platform }).catch(() => null);
        if (tool) return { ...tool, version: manifest.version, source: "cube-bundle" };
    }
    return null;
}

// Application bundles installed next to a launcher, or the bundle that contains it.
async function bundleDirectories(executable) {
    const parent = path.dirname(executable);
    if (path.basename(parent) === "dist") return [path.dirname(parent)];
    const base = path.join(parent, "resources", BUNDLE_NAME);
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
}

function substitute(value, root) {
    return typeof value === "string" ? value.split("${CUBE_BUNDLE_ROOT}").join(root) : "";
}

// Resolve the backend, CLI and bundled Node of an installed application bundle, as data from CubeBundle.json.
// version selects the bundle that matches a project; without it the newest bundle is used.
async function applicationBundle(tool, version, options = {}) {
    const platform = options.platform || process.platform;
    const suffix = platform === "win32" ? ".exe" : "";
    const bundles = [];
    for (const directory of await bundleDirectories(tool.executable)) {
        const manifest = await readJson(path.join(directory, "CubeBundle.json"));
        if (
            manifest?.name !== BUNDLE_NAME ||
            typeof manifest.version !== "string" ||
            !new RegExp(`^${VERSION}$`).test(manifest.version) ||
            path.basename(directory) !== manifest.version
        )
            continue;
        const command = (manifest.commands || []).find((entry) => entry?.name === "mx");
        const parts = typeof command?.exec === "string" ? command.exec.trim().split(/\s+/) : [];
        const [node, cli] = parts.map((part) => path.resolve(substitute(part, directory)));
        if (
            parts.length !== 2 ||
            !inside(directory, node) ||
            path.basename(cli) !== "bin.js" ||
            !inside(directory, cli)
        )
            continue;
        const env = {};
        for (const key of Array.isArray(manifest.export) ? manifest.export : [])
            if (/^[A-Z][A-Z0-9_]*$/.test(key) && typeof manifest.variables?.[key] === "string")
                env[key] = substitute(manifest.variables[key], directory);
        bundles.push({
            directory,
            version: manifest.version,
            backend: path.join(directory, "dist", `stm32cubemx2${suffix}`),
            node,
            cli,
            env
        });
    }
    bundles.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
    const selected = version ? bundles.find((bundle) => bundle.version === version) : bundles[0];
    if (!selected)
        throw failure(
            bundles.length ? "CUBEMX2_VERSION_MISMATCH" : "CUBEMX2_BUNDLE_MISSING",
            bundles.length
                ? "Install the CubeMX2 version recorded in the .ioc2; automatic migration is disabled"
                : "The configured CubeMX2 installation has no application bundle",
            { required: version || "", installed: bundles.map((bundle) => bundle.version) }
        );
    for (const file of [selected.backend, selected.node, selected.cli]) await fs.access(file);
    return selected;
}

function newest(installs) {
    installs.sort(
        (a, b) =>
            b.version.localeCompare(a.version, "en", { numeric: true }) || a.executable.localeCompare(b.executable)
    );
    return installs[0] || null;
}

async function discoverOfficial(options, platform, env, home) {
    const dataRoot =
        platform === "win32" ? env.LOCALAPPDATA : env.XDG_DATA_HOME || (home && path.join(home, ".local", "share"));
    const defaultRoot = dataRoot && path.join(dataRoot, "stm32cube", "bundles");
    const roots = (env.CUBE_BUNDLE_PATH || defaultRoot || "").split(path.delimiter).filter(path.isAbsolute);
    const installs = [];
    for (const root of roots) {
        const registry = await readJson(path.join(root, ".config", "external_bundles.json"));
        if (!Array.isArray(registry?.externally_managed_bundles)) continue;
        for (const entry of registry.externally_managed_bundles.slice(0, 256)) {
            const tool = await registeredInstallation(entry?.path, platform);
            if (tool) installs.push(tool);
        }
    }
    if (installs.length) return newest(installs);
    try {
        const result = await (options.exec || exec)(options.cubeCli || "cube", ["--resolve", "--json", "mx"], {
            env,
            timeout: 3000,
            windowsHide: true,
            maxBuffer: MAX_CONFIG_BYTES
        });
        const resolved = JSON.parse(result.stdout);
        const command = resolved.command;
        // Cube CLI returns ["cube", "node", <bin.js>] up to CubeMX2 1.1, and [<bundled node>, <bin.js>] since 1.2.
        const cli = Array.isArray(command) ? command[command.length - 1] : undefined;
        if (
            resolved.bundle?.name !== BUNDLE_NAME ||
            !Array.isArray(command) ||
            !(command.length === 2 || (command.length === 3 && command[1] === "node")) ||
            typeof cli !== "string" ||
            !path.isAbsolute(cli) ||
            path.basename(cli) !== "bin.js" ||
            path.basename(path.dirname(cli)) !== "dist"
        )
            return null;
        const tool = await registeredInstallation(path.resolve(cli, "../.."), platform);
        return tool?.version === resolved.bundle.version ? tool : null;
    } catch {
        return null;
    }
}

// Read installed shortcuts as data. No launcher is executed, including when its target is on another drive.
const SHORTCUT_SCRIPT = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$shell = New-Object -ComObject WScript.Shell",
    "$roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))",
    "foreach ($folder in @('Programs', 'CommonPrograms')) {",
    "  $root = [Environment]::GetFolderPath($folder)",
    "  if ($root) { $roots += $root; $roots += (Join-Path $root 'STMicroelectronics') }",
    "}",
    "foreach ($root in $roots | Select-Object -Unique) {",
    "  if ($root -and (Test-Path -LiteralPath $root)) {",
    "    Get-ChildItem -LiteralPath $root -Filter '*STM32CubeMX2*.lnk' -File -ErrorAction SilentlyContinue |",
    "      ForEach-Object { $shell.CreateShortcut($_.FullName).TargetPath }",
    "  }",
    "}"
].join("\n");

async function discover(options = {}) {
    const platform = options.platform || process.platform;
    if (!supportedPlatform(platform)) return null;
    const env = options.env || process.env;
    const home = (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || (options.env ? "" : os.homedir());
    const official = await discoverOfficial(options, platform, env, home);
    if (official) return official;
    const roots =
        options.roots ||
        (platform === "win32"
            ? [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA, "C:\\ST"].filter(Boolean)
            : [home, home && path.join(home, ".local", "share"), "/opt", "/usr/local"].filter(Boolean));
    const candidates = new Set();
    const directories = new Set();
    const add = (value) => {
        if (typeof value === "string" && path.isAbsolute(value.trim())) {
            value = value.trim();
            candidates.add(value);
            directories.add(value);
        }
    };
    for (const hint of options.hints || []) add(hint);
    for (const root of roots) {
        for (const directory of [
            path.join(root, "STM32CubeMX2"),
            path.join(root, "STMicroelectronics", "STM32Cube", "STM32CubeMX2"),
            path.join(root, "STMicroelectronics", "STM32CubeMX2"),
            path.join(root, "Programs", "STM32CubeMX2")
        ])
            directories.add(directory);
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => []))
            if (entry.isDirectory() && /^STM32CubeMX2(?:$|[-_ .])/i.test(entry.name))
                directories.add(path.join(root, entry.name));
    }
    for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) directories.add(directory);
    if (platform === "win32") {
        const run = options.exec || exec;
        const invoke = (command, args) =>
            run(command, args, { timeout: 3000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({
                stdout: ""
            }));
        const shortcuts = await invoke("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SHORTCUT_SCRIPT
        ]);
        for (const value of shortcuts.stdout.split(/\r?\n/)) add(value);
        for (const key of [
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
        ]) {
            const result = await invoke("reg.exe", ["query", key, "/s"]);
            for (const section of result.stdout.split(/(?=HKEY_)/)) {
                if (!/STM32CubeMX2/i.test(section)) continue;
                for (const match of section.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) add(match[1]);
            }
        }
    }
    for (const directory of directories)
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
            if (entry.isFile() && launcherPattern(platform).test(entry.name))
                candidates.add(path.join(directory, entry.name));
    const installs = (
        await Promise.all([...candidates].map((file) => installation(file, { platform }).catch(() => null)))
    ).filter(Boolean);
    return newest(installs);
}

module.exports = { installation, discover, applicationBundle };
