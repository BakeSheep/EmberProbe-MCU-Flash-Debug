"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const {
    FLASH_SPEED_KHZ,
    flashSpeedKhz,
    buildFlashProgramCommand,
    flashClockTracker,
    flashPhaseFromLine,
    isTentativeFlashPhase
} = require("../skills/_emberprobe/openocd-flash");
const { parseLine } = require("../src/openocdRunner");

function speedPolicy() {
    assert.strictEqual(flashSpeedKhz({ probe: "stlink.cfg" }), FLASH_SPEED_KHZ.stlink);
    assert.strictEqual(flashSpeedKhz({ probe: "jlink.cfg" }), FLASH_SPEED_KHZ.jlink);
    assert.strictEqual(flashSpeedKhz({ probe: "cmsis-dap.cfg" }), FLASH_SPEED_KHZ["cmsis-dap"]);
    assert.strictEqual(flashSpeedKhz({ probe: "custom.cfg", profile: { family: "stlink" } }), 24000);
    // An explicit setting is the programming clock; unknown adapters keep the script clock.
    assert.strictEqual(flashSpeedKhz({ probe: "stlink.cfg", adapterSpeedKhz: 1800 }), 1800);
    assert.strictEqual(flashSpeedKhz({ probe: "ftdi/olimex-arm-usb-ocd-h.cfg" }), 0);
    assert.strictEqual(flashSpeedKhz({ probe: "xds110.cfg" }), 0);
    assert.throws(() => flashSpeedKhz({ probe: "stlink.cfg", adapterSpeedKhz: -1 }), {
        code: "ADAPTER_SPEED_INVALID"
    });
}

function command() {
    const word = '"C:/a b/fw.elf"';
    const boosted = buildFlashProgramCommand(word, 24000);
    // OpenOCD's own program flow, events and verification stay in charge.
    assert(boosted.includes("program $file verify reset exit"));
    assert(boosted.includes("upcall reset") && boosted.includes("upcall flash"));
    assert(boosted.includes("verify_image_checksum [lindex $args 2]") && boosted.includes("EP_FLASH_STAGE=unchanged"));
    assert(boosted.includes("set ::_ep_flash_khz 24000;"));
    assert(boosted.includes("set ::_ep_flash_base [_ep_flash_boost $::_ep_flash_khz]"));
    // A fast write is checked once, by OpenOCD's verify_image; its failure triggers the slow retry.
    assert(boosted.includes("local proc verify_image") && boosted.includes("upcall flash write_image erase {*}$args"));
    assert(boosted.includes("{cortex_m hla_target}") && boosted.includes("{swd hla_swd dapdirect_swd}"));
    assert(boosted.includes("read_memory 0xE000ED00 32 1"));
    assert(boosted.includes("echo EP_FLASH_STAGE=speed_fallback; adapter speed $::_ep_flash_base;"));
    assert(boosted.endsWith(`_ep_flash_program ${word}`));
    assert(buildFlashProgramCommand(word).includes("set ::_ep_flash_khz 0;"));
    for (const value of [-1, 1.5, "8000; shutdown", "[exit]"])
        assert.throws(() => buildFlashProgramCommand(word, value), { code: "ADAPTER_SPEED_INVALID" });

    for (const phase of [
        "preverify",
        "unchanged",
        "program",
        "program_boost",
        "verify",
        "verify_boost",
        "speed_fallback"
    ])
        assert.strictEqual(flashPhaseFromLine(`EP_FLASH_STAGE=${phase}`), phase);
    assert.strictEqual(flashPhaseFromLine("EP_FLASH_STAGE=other", "init"), "init");
    assert(["preverify", "program_boost", "verify_boost"].every(isTentativeFlashPhase));
    assert(!isTentativeFlashPhase("program") && !isTentativeFlashPhase("speed_fallback"));

    assert.deepStrictEqual(
        [parseLine("EP_FLASH_STAGE=preverify"), parseLine("EP_FLASH_STAGE=program_boost")],
        [null, null]
    );
    assert.strictEqual(parseLine("EP_FLASH_STAGE=unchanged").key, "run.unchanged");
    assert.strictEqual(parseLine("EP_FLASH_STAGE=speed_fallback").key, "run.speedFallback");
    assert.deepStrictEqual(parseLine("EP_FLASH_SPEED=24000").params, { clock: "24000 kHz" });

    // J-Link logs its clamp before the marker; the clamped value is the effective clock.
    const jlink = flashClockTracker();
    assert.strictEqual(jlink("Info : Reduced speed from 15000 kHz to 12000 kHz (maximum)."), 0);
    assert.strictEqual(jlink("EP_FLASH_SPEED=15000"), 12000);
    assert.strictEqual(flashClockTracker()("EP_FLASH_SPEED=24000"), 24000);
}

function loadRunner(output, exitCode) {
    const filename = path.resolve(__dirname, "../src/openocdRunner.js");
    const localRequire = createRequire(filename);
    const mod = { exports: {} };
    const spawned = [];
    const overrides = {
        "./openocdScripts": {
            ...localRequire("./openocdScripts"),
            resolveOpenOcdLaunch: () => ({
                executable: "fake",
                probePath: "/interface/stlink.cfg",
                targetPath: "/target/stm32h7x.cfg",
                scriptsRoot: "/scripts",
                cwd: "/scripts"
            })
        },
        child_process: {
            spawn: (_file, args) => {
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.exitCode = null;
                child.signalCode = null;
                child.kill = () => {};
                spawned.push(args);
                setImmediate(() => {
                    child.stderr.end(output.join("\n") + "\n");
                    child.stdout.end();
                    setTimeout(() => {
                        child.exitCode = exitCode;
                        child.emit("close", exitCode);
                    }, 5);
                });
                return child;
            }
        }
    };
    vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(filename, "utf8") + "\n})", {
        filename
    })((name) => overrides[name] || localRequire(name), mod, mod.exports);
    const written = [];
    const vscode = {
        EventEmitter: class {
            fire(text) {
                written.push(text);
            }
        },
        window: { createTerminal: () => ({ show() {}, dispose() {} }) }
    };
    return { run: mod.exports.runOpenOcd, vscode, spawned, written };
}

const options = { executable: "fake", elf: "/fw.elf", probe: "stlink.cfg", target: "stm32h7x.cfg" };

async function unchangedRun() {
    const runner = loadRunner(
        [
            "EP_FLASH_STAGE=init",
            "EP_FLASH_STAGE=reset_init",
            "** Programming Started **",
            "EP_FLASH_STAGE=preverify",
            "EP_FLASH_STAGE=unchanged",
            "** Programming Finished **",
            "** Verify Started **",
            "** Verified OK **",
            "** Resetting Target **"
        ],
        0
    );
    const events = [];
    const result = await runner.run(runner.vscode, options, (event) => events.push(event));
    assert.strictEqual(result.unchanged, true);
    assert(runner.spawned[0].some((arg) => arg.includes("set ::_ep_flash_khz 24000;")));
    assert(events.some((event) => event.key === "run.unchanged"));
    assert.strictEqual(events.at(-1).key, "run.downloadUnchanged");
    assert(runner.written.some((text) => text.includes("已跳过擦写")));
}

async function fallbackRun() {
    const runner = loadRunner(
        [
            "Info : clock speed 4000 kHz",
            "EP_FLASH_STAGE=reset_init",
            "** Programming Started **",
            "EP_FLASH_STAGE=preverify",
            "Error: checksum mismatch",
            "Info : Reduced speed from 24000 kHz to 12000 kHz (maximum).",
            "EP_FLASH_SPEED=24000",
            "EP_FLASH_STAGE=program_boost",
            "** Programming Finished **",
            "** Verify Started **",
            "EP_FLASH_STAGE=verify_boost",
            "Error: checksum mismatch - attempting binary compare",
            "EP_FLASH_STAGE=speed_fallback",
            "EP_FLASH_STAGE=reset_init",
            "EP_FLASH_STAGE=program",
            "EP_FLASH_STAGE=verify",
            "** Verified OK **"
        ],
        0
    );
    const events = [];
    const result = await runner.run(runner.vscode, options, (event) => events.push(event));
    // Expected mismatches and failures at the raised clock are not reported as errors.
    assert(!events.some((event) => event.level === "error"));
    assert.deepStrictEqual(
        { unchanged: result.unchanged, flashClock: result.flashClock, speedFallback: result.speedFallback },
        { unchanged: false, flashClock: "12000 kHz", speedFallback: true }
    );
    assert.strictEqual(events.at(-1).key, "run.downloadSuccess");
    assert(runner.written.some((text) => text.includes("已降速重烧")));
}

async function failedFallbackRun() {
    const runner = loadRunner(
        [
            "EP_FLASH_STAGE=program_boost",
            "Error: Failed to write memory at 0x08000000",
            "EP_FLASH_STAGE=speed_fallback",
            "EP_FLASH_STAGE=program",
            "Error: flash write failed"
        ],
        1
    );
    const events = [];
    await assert.rejects(
        runner.run(runner.vscode, options, (event) => events.push(event)),
        (error) => {
            assert.strictEqual(error.stage, "program");
            return true;
        }
    );
    assert.deepStrictEqual(
        events.filter((event) => event.level === "error").map((event) => event.message),
        ["flash write failed"]
    );
}

(async () => {
    speedPolicy();
    command();
    await unchangedRun();
    await fallbackRun();
    await failedFallbackRun();
    console.log("Flash clock policy, unchanged-image skip and speed fallback tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
