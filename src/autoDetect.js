"use strict";
const fs = require("fs/promises");
const {
    detectProbe,
    usbInventory,
    probeFromText: debuggerFromInventory
} = require("../skills/_emberprobe/probe-detection");
const path = require("path");

async function isArmElf(file) {
    let handle;
    try {
        handle = await fs.open(file, "r");
        const header = Buffer.alloc(20);
        if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) return false;
        return (
            header.readUInt32BE(0) === 0x7f454c46 &&
            header[4] === 1 &&
            header[5] === 1 &&
            header.readUInt16LE(18) === 0x28
        );
    } catch {
        return false;
    } finally {
        await handle?.close();
    }
}

async function cargoTargetExecutables(root) {
    const target = process.env.CARGO_TARGET_DIR
        ? path.resolve(root, process.env.CARGO_TARGET_DIR)
        : path.join(root, "target");
    const candidates = [];
    const search = async (directory) => {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isFile() || (path.extname(entry.name) && !entry.name.endsWith(".elf"))) continue;
            const file = path.join(directory, entry.name);
            if (await isArmElf(file)) candidates.push(file);
        }
    };
    await Promise.all([search(path.join(target, "debug")), search(path.join(target, "release"))]);
    let targets = [];
    try {
        targets = await fs.readdir(target, { withFileTypes: true });
    } catch {
        return candidates;
    }
    await Promise.all(
        targets
            .filter((entry) => entry.isDirectory() && /^(?:thumb|riscv32)/.test(entry.name))
            .flatMap((entry) => ["debug", "release"].map((profile) => search(path.join(target, entry.name, profile))))
    );
    return candidates;
}

async function candidateElfFiles(vscode) {
    const found = await vscode.workspace.findFiles("**/*.elf", "{**/node_modules/**,**/.git/**}", 200);
    const roots = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    const cargo = await Promise.all(roots.map(cargoTargetExecutables));
    return [...new Set([...found.map((uri) => uri.fsPath), ...cargo.flat()])];
}

async function newestElf(vscode) {
    const files = await candidateElfFiles(vscode);
    const ranked = await Promise.all(
        files.map(async (file) => {
            try {
                return { file, mtime: (await fs.stat(file)).mtimeMs };
            } catch {
                return { file, mtime: 0 };
            }
        })
    );
    ranked.sort((a, b) => b.mtime - a.mtime);
    return ranked[0]?.file || "";
}

function targetFromText(text) {
    const value = text.toLowerCase();
    /** @type {Array<[RegExp, string]>} */
    const rules = [
        [/apm32f0/, "geehy/apm32f0x.cfg"],
        [/apm32f1/, "geehy/apm32f1x.cfg"],
        [/apm32f4/, "geehy/apm32f4x.cfg"],
        [/stm32f0/, "stm32f0x.cfg"],
        [/stm32f1/, "stm32f1x.cfg"],
        [/stm32f2/, "stm32f2x.cfg"],
        [/stm32f3/, "stm32f3x.cfg"],
        [/stm32f4/, "stm32f4x.cfg"],
        [/stm32f7/, "stm32f7x.cfg"],
        [/stm32g0/, "stm32g0x.cfg"],
        [/stm32g4/, "stm32g4x.cfg"],
        [/stm32h7/, "stm32h7x.cfg"],
        [/stm32l0/, "stm32l0.cfg"],
        [/stm32l1/, "stm32l1.cfg"],
        [/stm32l4/, "stm32l4x.cfg"],
        [/stm32l5/, "stm32l5x.cfg"],
        [/stm32u5/, "stm32u5x.cfg"],
        [/stm32wb/, "stm32wbx.cfg"],
        [/stm32wl/, "stm32wlx.cfg"],
        [/gd32vf103/, "gd32vf103.cfg"],
        [/gd32e23/, "gd32e23x.cfg"],
        [/nrf51/, "nordic/nrf51.cfg"],
        [/nrf52/, "nordic/nrf52.cfg"],
        [/rp2040/, "rp2040.cfg"],
        [/esp32s3/, "esp32s3.cfg"],
        [/esp32s2/, "esp32s2.cfg"],
        [/esp32/, "esp32.cfg"]
    ];
    return rules.find(([pattern]) => pattern.test(value))?.[1] || "";
}

async function detectMcu(vscode) {
    const candidates = [
        ...(await vscode.workspace.findFiles("**/*.ioc", "{**/node_modules/**,**/.git/**}", 20)),
        ...(await vscode.workspace.findFiles("**/{CMakeLists.txt,*.cmake,*.ld}", "{**/node_modules/**,**/.git/**}", 80))
    ];
    for (const uri of candidates) {
        try {
            const content = await fs.readFile(uri.fsPath, "utf8");
            const target = targetFromText(content + "\n" + path.basename(uri.fsPath));
            if (target) return target;
        } catch {}
    }
    return "";
}

async function detectDebugger() {
    const detected = await detectProbe();
    return { debugger: detected.probe, probeCandidates: detected.candidates };
}

async function detectWorkspace(vscode, backend = "openocd") {
    if (backend === "probe-rs") return { elf: await newestElf(vscode), mcu: "", debugger: "", probeCandidates: [] };
    const [elf, mcu, debuggerConfig] = await Promise.all([newestElf(vscode), detectMcu(vscode), detectDebugger()]);
    return { elf, mcu, ...debuggerConfig };
}
module.exports = {
    detectWorkspace,
    candidateElfFiles,
    cargoTargetExecutables,
    targetFromText,
    debuggerFromInventory,
    usbInventory
};
