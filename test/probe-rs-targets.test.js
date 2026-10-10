"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseProbeRsChipList, listProbeRsTargets, MAX_TARGET_LIST_BYTES } = require("../src/services/probeRsTargets");
const { detectWorkspace, probeRsTargetsFromText } = require("../src/autoDetect");

const output = [
    "Available chips:",
    "STM32F4 Series",
    "    Variants:",
    "        STM32F407ZG",
    "        STM32F407VG",
    "STM32H7 Series",
    "    Variants:",
    "        STM32H723VG",
    "        STM32H723VG",
    "        ../invalid",
    "        invalid chip",
    "nRF52 Series",
    "    Variants:",
    "        nRF52840_xxAA"
].join("\r\n");

async function main() {
    const targets = parseProbeRsChipList(output);
    assert.deepEqual(targets, [
        { label: "nRF52840_xxAA", description: "nRF52 Series" },
        { label: "STM32F407VG", description: "STM32F4 Series" },
        { label: "STM32F407ZG", description: "STM32F4 Series" },
        { label: "STM32H723VG", description: "STM32H7 Series" }
    ]);
    assert.deepEqual(parseProbeRsChipList("\u001b[32m" + output + "\u001b[0m"), targets);
    assert.deepEqual(parseProbeRsChipList("Available chips:\nSTM32F4 Series\n"), []);
    assert.deepEqual(parseProbeRsChipList("        STM32F407ZG\n"), [], "variants must belong to a family");
    assert.throws(() => parseProbeRsChipList("x".repeat(MAX_TARGET_LIST_BYTES + 1)), /budget/);

    let calls = 0;
    const listed = await listProbeRsTargets("C:/Tools with spaces/probe-rs.exe", {
        run: async (executable, args, options) => {
            calls++;
            assert.equal(executable, "C:/Tools with spaces/probe-rs.exe");
            assert.deepEqual(args, ["chip", "list"]);
            assert.equal(options.windowsHide, true);
            assert.equal(options.timeout, 10000);
            assert.equal(options.maxBuffer, MAX_TARGET_LIST_BYTES);
            return { stdout: output };
        }
    });
    assert.deepEqual(listed, targets);
    assert.equal(calls, 1);
    for (const stdout of ["", "Unknown output", "x".repeat(MAX_TARGET_LIST_BYTES + 1)]) {
        await assert.rejects(listProbeRsTargets("probe-rs", { run: async () => ({ stdout }) }), {
            code: "PROBE_RS_TARGET_LIST_FAILED",
            i18nKey: "pr.targetsFailed"
        });
    }
    for (const error of [new Error("timed out"), Object.assign(new Error("not found"), { code: "ENOENT" })]) {
        await assert.rejects(
            listProbeRsTargets("probe-rs", {
                run: async () => {
                    throw error;
                }
            }),
            (failure) => failure.i18nKey === "pr.targetsFailed" && failure.i18nParams.error === error.message
        );
    }
    await assert.rejects(listProbeRsTargets(""), { code: "PROBE_RS_TARGET_LIST_FAILED" });
    await assert.rejects(listProbeRsTargets("emberprobe-missing-probe-rs-executable"), {
        code: "PROBE_RS_TARGET_LIST_FAILED"
    });
    assert.deepEqual(probeRsTargetsFromText('runner = "probe-rs run --chip nRF52840_xxAA"', targets), [
        "nRF52840_xxAA"
    ]);
    assert.deepEqual(probeRsTargetsFromText("Mcu.CPN=STM32H723VGT6\nMcu.Name=STM32H723VGTx", targets), ["STM32H723VG"]);
    assert.deepEqual(probeRsTargetsFromText("stm32f407zgt6_FLASH.ld", targets), ["STM32F407ZG"]);
    assert.deepEqual(probeRsTargetsFromText("STM32F407VG STM32F407ZG", targets), ["STM32F407VG", "STM32F407ZG"]);
    assert.deepEqual(probeRsTargetsFromText("STM32F407xx APM32F407ZGT6", targets), [], "do not guess other variants");
    assert.deepEqual(
        probeRsTargetsFromText("STM32H723VGT6", [{ label: "STM32H723VGTx" }, { label: "STM32H723VG" }]),
        ["STM32H723VGTx", "STM32H723VG"],
        "registry aliases remain ambiguous"
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-probe-rs-hints-"));
    const files = ["board.ioc", "CMakeLists.txt", "config.toml", "launch.json", "large.cmake"];
    const uris = files.map((file) => ({ fsPath: path.join(root, file) }));
    const hints = new Map();
    const vscode = {
        workspace: {
            workspaceFolders: [],
            findFiles: async (pattern) => {
                if (pattern === "**/*.elf") return [];
                return [...hints.keys()].map((fsPath) => ({ fsPath }));
            }
        }
    };
    try {
        await fs.writeFile(uris[0].fsPath, "Mcu.CPN=STM32H723VGT6\n");
        hints.set(uris[0].fsPath, true);
        const detected = await detectWorkspace(vscode, "probe-rs", targets);
        assert.equal(detected.mcu, "STM32H723VG");
        assert.deepEqual(detected.mcuCandidates, ["STM32H723VG"]);
        assert.equal(detected.debugger, "");
        for (const [index, content, expected] of [
            [1, 'set(CHIP "STM32F407ZG")', "STM32F407ZG"],
            [2, 'runner = "probe-rs run --chip nRF52840_xxAA"', "nRF52840_xxAA"],
            [3, '{ "chip": "STM32F407VG" }', "STM32F407VG"]
        ]) {
            hints.clear();
            await fs.writeFile(uris[index].fsPath, content);
            hints.set(uris[index].fsPath, true);
            assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, expected);
        }
        hints.set(uris[0].fsPath, true);
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "", "conflicting hints need selection");
        assert.equal(
            (await detectWorkspace(vscode, "probe-rs", targets, uris[0].fsPath)).mcu,
            "STM32H723VG",
            "the ioc selected during one-click configuration takes precedence over other projects"
        );
        hints.clear();
        await fs.writeFile(uris[4].fsPath, "STM32H723VG " + " ".repeat(128 * 1024));
        hints.set(uris[4].fsPath, true);
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "", "oversized hint files are skipped");
        hints.clear();
        hints.set(path.join(root, "missing.ioc"), true);
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "");
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets, path.join(root, "missing.ioc"))).mcu, "");
        assert.equal((await detectWorkspace(vscode, "probe-rs")).mcu, "");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("probe-rs target registry parsing, subprocess bounds and failure tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
