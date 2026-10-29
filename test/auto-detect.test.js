"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const targets = require("../skills/_emberprobe/target-detection");
const { probeCandidates } = require("../skills/_emberprobe/probe-detection");
const { extractProjectParts, DeviceIdentityService } = require("../src/services/deviceIdentityService");
const autoDetect = require("../src/autoDetect");
const flashCommon = require("../skills/_emberprobe/flash-common");
const { ConfigurationStore } = require("../src/services/configurationStore");
const { loadProvider } = require("./helpers/load-provider");

function elfHeader(machine) {
    const header = Buffer.alloc(52);
    header.writeUInt32BE(0x7f454c46, 0);
    header[4] = 1;
    header[5] = 1;
    header[6] = 1;
    header.writeUInt16LE(machine, 18);
    return header;
}

// ELF32 header + section name table + section headers (null, .shstrtab, then `sections`).
function elfWithSections(machine, sections) {
    const names = ["", ".shstrtab", ...sections.map((section) => section.name)];
    const offsets = [];
    let strtab = "";
    for (const name of names) {
        offsets.push(strtab.length);
        strtab += `${name}\0`;
    }
    const strtabBytes = Buffer.from(strtab, "latin1");
    const shoff = 52 + strtabBytes.length;
    const table = Buffer.alloc(names.length * 40);
    const entry = (index, type, offset, size) => {
        table.writeUInt32LE(offsets[index], index * 40);
        table.writeUInt32LE(type, index * 40 + 4);
        table.writeUInt32LE(offset, index * 40 + 16);
        table.writeUInt32LE(size, index * 40 + 20);
    };
    entry(1, 3, 52, strtabBytes.length);
    sections.forEach((section, i) => entry(i + 2, section.type ?? 1, 0, section.size ?? 16));
    const header = elfHeader(machine);
    header.writeUInt32LE(shoff, 32);
    header.writeUInt16LE(40, 46);
    header.writeUInt16LE(names.length, 48);
    header.writeUInt16LE(1, 50);
    return Buffer.concat([header, strtabBytes, table]);
}

function write(root, relative, content, mtime) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
}

function walk(root) {
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

// Minimal findFiles: the production globs are exercised through the shared predicates.
function fakeVscode(root) {
    return {
        workspace: {
            findFiles: async (glob) => {
                const files = walk(root);
                const ignoredProject = (file) => targets.isIgnoredProjectPath(file, root);
                const ignoredElf = (file) =>
                    path
                        .relative(root, file)
                        .split(path.sep)
                        .some((part) => targets.ELF_IGNORED_DIRS.includes(part));
                const selected =
                    glob === targets.ELF_FILE_GLOB
                        ? files.filter((file) => targets.isElfCandidateName(file) && !ignoredElf(file))
                        : files.filter((file) => targets.sourcePriority(file) >= 0 && !ignoredProject(file));
                return selected.map((fsPath) => ({ fsPath }));
            }
        }
    };
}

const noProbe = async () => ({ probe: "", candidates: [], notes: [] });

(async () => {
    // Every rule's own family name resolves to exactly that rule; no prefix overlaps.
    const samples = {
        stm32f103c8t6: "stm32f1x.cfg",
        stm32f103zgt6tr: "stm32xl.cfg",
        "-DSTM32F103xG": "stm32xl.cfg",
        STM32F10X_XL: "stm32xl.cfg",
        stm32f030f4: "stm32f0x.cfg",
        stm32f407vgtx: "stm32f4x.cfg",
        "-DSTM32F407xx": "stm32f4x.cfg",
        "/DSTM32F407xx": "stm32f4x.cfg",
        "startup_stm32f407xx.s": "stm32f4x.cfg",
        stm32c031c6: "stm32c0x.cfg",
        stm32c562re: "stm32c5x.cfg",
        "-DSTM32C5A3xx": "stm32c5x.cfg",
        stm32g071rb: "stm32g0x.cfg",
        stm32h743zitx: "stm32h7x_dual_bank.cfg",
        stm32h745zitx: "stm32h7x_dual_bank.cfg",
        stm32h723zgtx: "stm32h7x.cfg",
        stm32h750vbtx: "stm32h7x.cfg",
        stm32u083rc: "stm32u0x.cfg",
        stm32u575zi: "stm32u5x.cfg",
        stm32wb55rg: "stm32wbx.cfg",
        stm32wba52cg: "stm32wbax.cfg",
        stm32wb05kz: "",
        stm32wle5jc: "stm32wlx.cfg",
        apm32f103cb: "geehy/apm32f1x.cfg",
        nrf52840: "nordic/nrf52.cfg",
        nrf5340: "nordic/nrf53.cfg",
        nrf54l15: "nordic/nrf54l.cfg",
        nrf9160: "nordic/nrf91.cfg",
        rp2040: "rp2040.cfg",
        rp2350: "rp2350.cfg",
        esp32: "esp32.cfg",
        "ESP32-WROOM": "esp32.cfg",
        esp32s3: "esp32s3.cfg",
        "ESP32-S3": "esp32s3.cfg",
        esp32c3: "esp32c3.cfg",
        "ESP32-C6": "esp32c6.cfg",
        esp32h2: "esp32h2.cfg",
        "Host Link": "",
        xrp2040: "",
        GD32F303RC: ""
    };
    for (const [text, expected] of Object.entries(samples))
        assert.strictEqual(targets.targetFromText(text), expected, text);

    // Explicit device fields from vendor project files.
    const fields = {
        "Mcu.Name=STM32F407V(E-G)Tx\nMcu.UserName=STM32F407VGTx": "STM32F407VGTx",
        "<Device>STM32F103C8</Device>": "STM32F103C8",
        "<name>OGChipSelectEditMenu</name>\n<state>STM32F407VG\tST STM32F407VG</state>": "STM32F407VG",
        '<option id="x" superClass="com.st.stm32cube.ide.mcu.gnu.managedbuild.option.target_mcu" value="STM32G474RETx" valueType="string"/>':
            "STM32G474RETx",
        "[env:x]\nboard_build.mcu = stm32f401cc": "stm32f401cc",
        'CONFIG_IDF_TARGET="esp32c3"': "esp32c3"
    };
    for (const [text, expected] of Object.entries(fields)) assert.strictEqual(targets.deviceField(text), expected);

    // An explicit but unknown device never falls back to incidental text.
    assert.strictEqual(targets.targetFromText("<Device>GD32F303RC</Device>\n<!-- ported from stm32f103 -->"), "");
    // A file naming two families is ambiguous; filenames win over content.
    assert.strictEqual(targets.targetFromText("/* migrated from stm32f103 */ for STM32F407"), "");
    assert.strictEqual(
        targets.resolveTarget([{ file: "/p/STM32F407VGTX_FLASH.ld", text: "/* migrated from stm32f103 */" }]).target,
        "stm32f4x.cfg"
    );
    // Generic and specific variants of one family are not ambiguous.
    assert.strictEqual(targets.targetFromText("STM32H743xx Drivers/STM32H7xx_HAL_Driver"), "stm32h7x_dual_bank.cfg");

    // Higher-trust sources decide; conflicting .ioc files are ambiguous, a preferred one decides alone.
    const ordered = targets.orderProjectFiles([
        "/w/lib/CMakeLists.txt",
        "/w/app/app.ioc",
        "/w/boot/boot.ioc",
        "/w/app/STM32F407VGTX_FLASH.ld"
    ]);
    assert.deepStrictEqual(ordered, [
        "/w/app/app.ioc",
        "/w/boot/boot.ioc",
        "/w/app/STM32F407VGTX_FLASH.ld",
        "/w/lib/CMakeLists.txt"
    ]);
    const entries = [
        { file: "/w/app/app.ioc", text: "Mcu.UserName=STM32F407VGTx" },
        { file: "/w/boot/boot.ioc", text: "Mcu.UserName=STM32F030F4Px" },
        { file: "/w/lib/CMakeLists.txt", text: "GCC_RP2040" }
    ];
    const conflict = targets.resolveTarget(entries);
    assert.strictEqual(conflict.target, "");
    assert.deepStrictEqual(conflict.candidates.sort(), ["stm32f0x.cfg", "stm32f4x.cfg"]);
    const preferred = targets.resolveTarget(entries, { preferred: "/w/app/app.ioc" });
    assert.strictEqual(preferred.target, "stm32f4x.cfg");
    assert.strictEqual(preferred.projectDir, path.dirname("/w/app/app.ioc"));
    assert.strictEqual(targets.resolveTarget(entries.slice(2)).target, "rp2040.cfg");

    // ELF selection: architecture mismatches are rejected, project images win, ties are deterministic.
    assert.deepStrictEqual(targets.elfHeaderInfo(elfHeader(40)), { machine: 40, arch: "arm" });
    assert.strictEqual(targets.elfHeaderInfo(Buffer.from("not an elf at all....")), null);
    const images = [
        { file: path.resolve("/w/vendor/prebuilt.elf"), mtimeMs: 300, arch: "arm" },
        { file: path.resolve("/w/app/build/app.elf"), mtimeMs: 100, arch: "arm" },
        { file: path.resolve("/w/riscv/fw.elf"), mtimeMs: 500, arch: "riscv" }
    ];
    assert.strictEqual(
        targets.chooseElf(images, { target: "stm32f4x.cfg", projectDir: path.resolve("/w/app") }).elf,
        path.resolve("/w/app/build/app.elf")
    );
    const unpaired = targets.chooseElf(images, { target: "stm32f4x.cfg" });
    assert.strictEqual(unpaired.elf, path.resolve("/w/vendor/prebuilt.elf"));
    assert.deepStrictEqual(unpaired.rejected, [path.resolve("/w/riscv/fw.elf")]);
    assert.strictEqual(targets.chooseElf(images.slice(2), { target: "stm32f4x.cfg" }).elf, "");
    assert.strictEqual(targets.chooseElf(images).elf, path.resolve("/w/riscv/fw.elf"));

    // Debug info outranks mtime: a newer stripped Release image loses to an older Debug image.
    const debugElf = path.resolve("/w/app/build/Debug/app.elf");
    const releaseElf = path.resolve("/w/app/build/Release/app.elf");
    const builds = [
        { file: releaseElf, mtimeMs: 1001, arch: "arm", dwarf: false },
        { file: debugElf, mtimeMs: 1000, arch: "arm", dwarf: true }
    ];
    const projectDir = path.resolve("/w/app");
    assert.strictEqual(targets.chooseElf(builds, { target: "stm32f4x.cfg", projectDir }).elf, debugElf);
    const bothDebug = builds.map((image) => ({ ...image, dwarf: true }));
    assert.strictEqual(targets.chooseElf(bothDebug, { target: "stm32f4x.cfg", projectDir }).elf, releaseElf);
    const unknown = [builds[0], { ...builds[1], dwarf: undefined }];
    assert.strictEqual(targets.chooseElf(unknown, { projectDir }).elf, debugElf, "unknown DWARF ranks like DWARF");
    const unknownNewer = [{ ...builds[0], dwarf: undefined }, builds[1]];
    assert.strictEqual(targets.chooseElf(unknownNewer, { projectDir }).elf, releaseElf, "unknown ties go by mtime");
    const unchecked = builds.map(({ dwarf: _dwarf, ...image }) => image);
    assert.strictEqual(targets.chooseElf(unchecked, { projectDir }).elf, releaseElf, "no DWARF data keeps mtime order");
    // The project root still decides first, and architecture rejection ignores debug info.
    const outside = [{ file: path.resolve("/w/vendor/debug.elf"), mtimeMs: 2000, arch: "arm", dwarf: true }, builds[0]];
    assert.strictEqual(targets.chooseElf(outside, { projectDir }).elf, releaseElf);
    const foreign = [...builds, { file: path.resolve("/w/riscv/fw.elf"), mtimeMs: 5000, arch: "riscv", dwarf: true }];
    const foreignChoice = targets.chooseElf(foreign, { target: "stm32f4x.cfg", projectDir });
    assert.strictEqual(foreignChoice.elf, debugElf);
    assert.deepStrictEqual(foreignChoice.rejected, [path.resolve("/w/riscv/fw.elf")]);

    // Probe names must start at a word boundary.
    assert.deepStrictEqual(probeCandidates("Microsoft Host Link Adapter\nMenu Link"), []);
    assert.deepStrictEqual(probeCandidates("STLINK-V3\nNuvoton Nu-Link"), ["stlink.cfg", "nulink.cfg"]);

    // SVD identity: one CubeMX project yields one exact part.
    const ioc = [
        "Mcu.CPN=STM32F407VGT6",
        "Mcu.Family=STM32F4",
        "Mcu.Name=STM32F407V(E-G)Tx",
        "Mcu.UserName=STM32F407VGTx",
        "ProjectManager.DeviceId=STM32F407VGTx"
    ].join("\n");
    assert.deepStrictEqual(extractProjectParts(ioc), ["STM32F407VGTX"]);
    const identity = new DeviceIdentityService().resolve({
        project: extractProjectParts(ioc).map((part) => ({ part, file: "a.ioc" })),
        target: "stm32f4x.cfg"
    });
    assert.strictEqual(identity.exact, true);
    assert.strictEqual(identity.device, "STM32F407VGTX");

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auto-detect-")));
    try {
        const now = Date.now() / 1000;
        write(root, "app/app.ioc", "Mcu.UserName=STM32F407VGTx\n", now - 50);
        write(root, "app/STM32F407VGTX_FLASH.ld", "/* migrated from stm32f103 */", now - 50);
        write(root, "app/build/CMakeFiles/cmTC.elf", elfHeader(40), now);
        const appElf = write(root, "app/build/app.elf", elfHeader(40), now - 20);
        write(root, "vendor/blob/prebuilt.axf", elfHeader(40), now - 10);
        write(root, "tools/notes.out", "plain text output", now);
        write(root, "build/generated.ioc", "Mcu.UserName=STM32F030F4Px\n", now);
        const keilImage = write(root, "keil/Objects/fw.axf", elfHeader(243), now - 5);

        const vscode = fakeVscode(root);
        const images = await autoDetect.elfImages(vscode);
        assert(!images.some((image) => image.file.endsWith("notes.out")), "non-ELF .out files are ignored");
        assert(
            images.some((image) => image.file === keilImage),
            "Keil .axf images are candidates"
        );
        const detected = await autoDetect.detectWorkspace(vscode, { detectProbe: noProbe });
        assert.strictEqual(detected.mcu, "stm32f4x.cfg");
        assert.strictEqual(detected.elf, appElf, "the image under the detected project wins over newer images");
        // OpenOCD without the script: the detected target is reported but not configured.
        const missing = await autoDetect.detectWorkspace(vscode, { detectProbe: noProbe, targets: ["stm32f1x.cfg"] });
        assert.strictEqual(missing.mcu, "");
        assert.strictEqual(missing.mcuUnavailable, "stm32f4x.cfg");
        const filteredProbe = await autoDetect.detectWorkspace(vscode, {
            detectProbe: async () => ({ probe: "", candidates: ["stlink.cfg", "xds110.cfg"], notes: [] }),
            interfaces: ["stlink.cfg"]
        });
        assert.strictEqual(filteredProbe.debugger, "stlink.cfg");

        // The mcu-flash skill infers the same target and image without the extension.
        const skillTarget = flashCommon.inferTargetDetails(root);
        assert.strictEqual(skillTarget.target, "stm32f4x.cfg");
        assert.strictEqual(
            flashCommon.findNewestElf(root, { target: skillTarget.target, projectDir: skillTarget.projectDir }),
            appElf
        );

        // Keil/IAR images are accepted configuration values; other extensions are not.
        const state = new Map();
        const store = new ConfigurationStore({
            vscode: {
                workspace: {
                    workspaceFolders: [{ uri: { fsPath: root } }],
                    getConfiguration: () => ({ get: (_key, value) => value, update: async () => {} })
                },
                ConfigurationTarget: { Workspace: 2 }
            },
            context: { workspaceState: { get: (key) => state.get(key), update: async (k, v) => state.set(k, v) } },
            cacheKeys: { elfPath: "mcu.elfPath", debugger: "mcu.debugger", mcuCore: "mcu.mcuCore", svdPath: "svd" },
            cleanPath: (value) => value,
            isSafeCfg: () => true,
            onChanged: async () => {}
        });
        await store.update({ elf: "keil/Objects/fw.axf" });
        assert.strictEqual(state.get("mcu.elfPath"), keilImage);
        await assert.rejects(store.update({ elf: "tools/notes.txt" }), (error) =>
            ["INVALID_FILE_TYPE", "FILE_NOT_FOUND"].includes(error.code)
        );
        write(root, "tools/notes.txt", "x");
        await assert.rejects(store.update({ elf: "tools/notes.txt" }), { code: "INVALID_FILE_TYPE" });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    // CubeIDE Debug/Release layout: the older Debug image with .debug_info is detected over a
    // Release image built a second later without it.
    const buildRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auto-detect-dwarf-")));
    try {
        const now = Date.now() / 1000;
        write(buildRoot, "F407_car/F407_car.ioc", "Mcu.UserName=STM32F407VGTx\n", now - 50);
        const debugImage = write(
            buildRoot,
            "F407_car/build/Debug/F407_car.elf",
            elfWithSections(40, [{ name: ".text" }, { name: ".debug_info" }]),
            now - 1
        );
        const releaseImage = write(
            buildRoot,
            "F407_car/build/Release/F407_car.elf",
            elfWithSections(40, [{ name: ".text" }, { name: ".ARM.attributes" }]),
            now
        );
        const placeholder = write(
            buildRoot,
            "F407_car/build/Nobits/F407_car.elf",
            elfWithSections(40, [{ name: ".debug_info", type: 8 }]),
            now
        );
        const truncated = write(buildRoot, "F407_car/build/Truncated/F407_car.elf", elfHeader(40).subarray(0, 40), now);
        const vscode = fakeVscode(buildRoot);
        const byFile = new Map((await autoDetect.elfImages(vscode)).map((image) => [image.file, image]));
        assert.strictEqual(byFile.get(debugImage).dwarf, true);
        assert.strictEqual(byFile.get(releaseImage).dwarf, false);
        assert.strictEqual(byFile.get(placeholder).dwarf, false, "an SHT_NOBITS .debug_info carries no DWARF");
        assert.strictEqual(byFile.get(truncated).dwarf, undefined, "a header too short to check stays unknown");
        fs.rmSync(truncated);
        const detected = await autoDetect.detectWorkspace(vscode, { detectProbe: noProbe });
        assert.strictEqual(detected.elf, debugImage);
    } finally {
        fs.rmSync(buildRoot, { recursive: true, force: true });
    }

    // runAutoDetect: busy sessions skip connection fields without a partial write or error;
    // forced detection prompts for ambiguous targets and applies the user's .ioc.
    let detectOptions;
    let detectedProbe = { debugger: "stlink.cfg", probeCandidates: ["stlink.cfg"] };
    const picks = [];
    const Provider = loadProvider(
        {
            window: {
                showInformationMessage() {},
                showWarningMessage() {},
                showQuickPick: async (items) => {
                    picks.push(items);
                    return items[1];
                }
            },
            workspace: { getConfiguration: () => ({ get: (_key, value) => value }) }
        },
        {
            "./autoDetect": {
                detectWorkspace: async (_vscode, options) => {
                    detectOptions = options;
                    return {
                        elf: "/w/app.elf",
                        mcu: "",
                        mcuCandidates: ["stm32f0x.cfg", "stm32f4x.cfg"],
                        ...detectedProbe
                    };
                }
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    const workspace = new Map();
    let refreshed = 0;
    provider._context = {
        workspaceState: { get: (key) => workspace.get(key) || "", update: async (k, v) => workspace.set(k, v) }
    };
    provider._debugBridge = { hasAnySession: false };
    provider._liveSession = { active: true };
    provider._assertProbeDriverIdle = () => {};
    provider._cubemxConfiguration = { detectIoc: async () => "/w/app/app.ioc" };
    provider._refreshElfBindings = async () => refreshed++;
    provider._refreshConnectedProbes = async () => null;
    provider.updateView = async () => {};
    provider._t = (key) => key;
    await provider.runAutoDetect(false);
    assert.strictEqual(workspace.get("mcu.elfPath"), "/w/app.elf");
    assert.strictEqual(refreshed, 1, "an automatically selected ELF is bound immediately");
    assert(!workspace.has("mcu.debugger") && !workspace.has("mcu.mcuCore"), "busy sessions keep connection settings");
    assert.strictEqual(detectOptions.ioc, "");
    await assert.rejects(provider.runAutoDetect(true), { code: "PROBE_CONFIGURATION_BUSY" });
    provider._liveSession = null;
    await provider.runAutoDetect(true);
    assert.strictEqual(detectOptions.ioc, "/w/app/app.ioc", "the selected .ioc decides the target");
    assert.deepStrictEqual(picks.at(-1), ["stm32f0x.cfg", "stm32f4x.cfg"]);
    assert.strictEqual(workspace.get("mcu.mcuCore"), "stm32f4x.cfg");
    assert.strictEqual(workspace.get("mcu.debugger"), "stlink.cfg");

    // Several probe types: nothing prompts for one; a forced detection opens the connected probe list, where
    // picking a device also sets its interface script.
    let reveals = 0;
    provider._revealConnectedProbes = () => reveals++;
    detectedProbe = { debugger: "", probeCandidates: ["stlink.cfg", "jlink.cfg"] };
    workspace.delete("mcu.debugger");
    const picksBefore = picks.length;
    await provider.runAutoDetect(false);
    assert.strictEqual(reveals, 0, "background detection does not open the list");
    await provider.runAutoDetect(true);
    assert.strictEqual(reveals, 1);
    assert(
        picks.slice(picksBefore).every((items) => !items.includes("jlink.cfg")),
        "probe types are not offered in a VS Code picker"
    );
    assert(!workspace.has("mcu.debugger"), "no interface script is guessed");

    console.log("Auto-detect tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
