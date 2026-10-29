"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const {
    normalizeTargetIdentity,
    targetCheckCommand,
    parseTargetIdentityLine,
    withTargetCheck,
    describeTargetIdentity,
    describeTargetCore,
    sameTarget,
    targetMatchesModel,
    targetCheckMonitor,
    observedTargetIdentity,
    onTargetMismatch
} = require("../src/chip/targetIdentity");
const { runOpenOcdOnce } = require("../src/services/openocdExec");
const { normalizeSelection } = require("../src/services/probeSelectionStore");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");

const F407 = { cpuid: "410FC241", idcode: "10076413", uid: "002900124131381253534C32" };
const H750 = { cpuid: "411FC271", idcode: "20036450", uid: "0050002B3133510232363235" };
const OTHER_F407 = { ...F407, uid: "00290012413138125353AAAA" };

function fakeSpawn(lines, exitCode, calls) {
    return (executable, args) => {
        calls.push(args);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            child.stderr.emit("data", Buffer.from(lines.join("\n") + "\n"));
            child.emit("close", exitCode, null);
        });
        return child;
    };
}

async function main() {
    // The check reads CPUID and the target's DBGMCU IDCODE and UID, and compares only valid expected fields.
    const f4 = targetCheckCommand("stm32f4x.cfg", F407);
    assert(f4.includes("cpuid [_ep_target_word 0xe000ed00 1]"));
    assert(f4.includes("idcode [_ep_target_word 0xe0042000 1]"));
    assert(f4.includes("uid [_ep_target_word 0x1fff7a10 3]"));
    // Revision bits are masked on both sides: CPUID variant/revision and DBGMCU REV_ID.
    assert(f4.includes(`{cpuid 410FC240 idcode 00000413 uid ${F407.uid}}`));
    assert(f4.includes("[_ep_target_key $_ep_field $_ep_read] ne $_ep_value"));
    assert(f4.includes("& 0xff0ffff0") && f4.includes("& 0xfff"));
    assert(f4.includes("shutdown error"));
    assert(!/\b(?:halt|reset|mww|write_memory)\b/.test(f4), "the check never halts, resets or writes");
    assert(targetCheckCommand("stm32h7x.cfg").includes("idcode [_ep_target_word 0x5c001000 1]"));
    assert(!targetCheckCommand("stm32f4x.cfg").includes("shutdown error"), "without a record the check only reads");
    const nrf = targetCheckCommand("nordic/nrf52.cfg", { cpuid: "410FC241" });
    assert(nrf.includes(" cpuid [_ep") && !nrf.includes(" idcode [_ep") && !nrf.includes(" uid [_ep"));
    assert.strictEqual(normalizeTargetIdentity({ cpuid: "410FC241]; shutdown" }), null);
    assert(!targetCheckCommand("stm32f4x.cfg", { cpuid: "41 0FC241" }).includes("shutdown error"));
    assert.deepStrictEqual(normalizeTargetIdentity({ cpuid: "410fc241", idcode: "" }), {
        cpuid: "410FC241",
        idcode: "",
        uid: ""
    });

    assert.deepStrictEqual(
        parseTargetIdentityLine(`EP_TARGET_ID cpuid=${F407.cpuid} idcode=${F407.idcode} uid=${F407.uid}`),
        F407
    );
    assert.deepStrictEqual(parseTargetIdentityLine("EP_TARGET_ID cpuid=410FC241 idcode= uid="), {
        cpuid: "410FC241",
        idcode: "",
        uid: ""
    });
    assert.strictEqual(parseTargetIdentityLine("EP_TARGET_ID cpuid= idcode= uid="), null);
    assert.strictEqual(parseTargetIdentityLine("Info : EP_TARGET_ID cpuid=410FC241"), null);

    // The check follows the operation's init; an operation that initializes later starts with it.
    const check = { checkId: "a", expected: F407 };
    const inserted = withTargetCheck(["set x 1", "init", "flash probe 0", "shutdown"], check, "stm32f4x.cfg");
    assert.deepStrictEqual(inserted.slice(0, 2), ["set x 1", "init"]);
    assert(inserted[2].includes("EP_TARGET_ID"));
    assert.deepStrictEqual(inserted.slice(3), ["flash probe 0", "shutdown"]);
    const program = withTargetCheck(["configure", "program x"], check, "stm32f4x.cfg");
    assert.deepStrictEqual([program[0], program[2], program[3]], ["init", "configure", "program x"]);
    assert.deepStrictEqual(withTargetCheck(["init"], null, "stm32f4x.cfg"), ["init"]);

    assert.strictEqual(describeTargetIdentity(F407), "STM32F4x · Cortex-M4 · UID …53534C32");
    assert.strictEqual(describeTargetIdentity({ cpuid: "410FC241" }), "Cortex-M4");
    assert.strictEqual(describeTargetIdentity({ idcode: "00000999" }), "DEV_ID 0x999");
    assert.deepStrictEqual(
        [describeTargetCore(F407), describeTargetCore({ idcode: "00000999" }), describeTargetCore(null)],
        ["Cortex-M4", "", ""],
        "a probe's card shows only the core"
    );
    assert(sameTarget(F407, { ...F407, idcode: "" }));
    assert(!sameTarget(F407, OTHER_F407));
    assert(!sameTarget(F407, null));
    // Another silicon revision of the same model: REV_ID and the core's variant/revision differ, the model does not.
    const otherRevision = { cpuid: "411FC272", idcode: "20036450" };
    assert(sameTarget({ cpuid: "410FC271", idcode: "10036450" }, otherRevision));
    assert(!sameTarget({ cpuid: "410FC241", idcode: "10006413" }, otherRevision), "another model still differs");
    assert(!sameTarget({ idcode: "20036451" }, otherRevision), "another DEV_ID still differs");
    assert.strictEqual(targetMatchesModel(F407, "stm32f4x.cfg"), true);
    assert.strictEqual(targetMatchesModel(H750, "stm32f4x.cfg"), false);
    assert.strictEqual(targetMatchesModel({ cpuid: "411FC271" }, "stm32h7x.cfg"), true, "core decides without IDCODE");
    assert.strictEqual(targetMatchesModel(F407, "nordic/nrf52.cfg"), null);
    // C0 shares the G0 DBGMCU address; C5 is read through its CPU-side DBGMCU.
    const c0 = targetCheckCommand("stm32c0x.cfg");
    assert(c0.includes("idcode [_ep_target_word 0x40015800 1]") && c0.includes("uid [_ep_target_word 0x1fff7550 3]"));
    const c5 = targetCheckCommand("stm32c5x.cfg");
    assert(c5.includes("idcode [_ep_target_word 0x44024000 1]") && c5.includes("uid [_ep_target_word 0x8fff800 3]"));
    assert.strictEqual(targetMatchesModel({ cpuid: "410CC601", idcode: "10006453" }, "stm32c0x.cfg"), true);
    assert.strictEqual(targetMatchesModel({ cpuid: "410FD213", idcode: "1000644E" }, "stm32c5x.cfg"), true);
    assert.strictEqual(targetMatchesModel({ cpuid: "410FD213", idcode: "1000644E" }, "stm32c0x.cfg"), false);

    // A session's output records the observed chip under its check id; a mismatch becomes one structured error.
    const mismatches = [];
    const stop = onTargetMismatch((error) => mismatches.push(error));
    const monitor = targetCheckMonitor({ checkId: "check-a", target: "stm32f4x.cfg", expected: F407 });
    assert(monitor.line(`EP_TARGET_ID cpuid=${H750.cpuid} idcode=${H750.idcode} uid=${H750.uid}`));
    assert.deepStrictEqual(observedTargetIdentity("check-a"), H750);
    assert.strictEqual(monitor.error(), null, "no mismatch line, no error");
    assert(monitor.line("EP_TARGET_MISMATCH idcode"));
    const mismatch = monitor.error();
    assert.strictEqual(monitor.error(), mismatch);
    assert.strictEqual(mismatch.code, "PROBE_TARGET_MISMATCH");
    assert.strictEqual(mismatch.i18nKey, "probe.targetMismatch");
    assert.deepStrictEqual(mismatch.i18nParams, {
        expected: "STM32F4x · Cortex-M4 · UID …53534C32",
        actual: "STM32H7x · Cortex-M7 · UID …32363235"
    });
    assert.deepStrictEqual(mismatch.details, {
        checkId: "check-a",
        target: "stm32f4x.cfg",
        field: "idcode",
        expected: F407,
        observed: H750
    });
    assert.deepStrictEqual(mismatches, [mismatch], "listeners hear a mismatch once");
    stop();

    // One-shot OpenOCD runs carry the check and report a mismatch instead of a bare exit status.
    const launch = {
        executable: "openocd",
        probePath: "/s/interface/jlink.cfg",
        targetPath: "/s/target/stm32f4x.cfg",
        scriptsRoot: "/s"
    };
    const calls = [];
    const base = {
        probe: "jlink.cfg",
        target: "stm32f4x.cfg",
        resolveLaunch: () => launch,
        buildCommands: () => ["init", "echo ok", "shutdown"],
        targetCheck: { checkId: "check-b", target: "stm32f4x.cfg", expected: F407 }
    };
    const idLine = `EP_TARGET_ID cpuid=${F407.cpuid} idcode=${F407.idcode} uid=${F407.uid}`;
    const passed = await runOpenOcdOnce({ ...base, spawnImpl: fakeSpawn([idLine, "ok"], 0, calls) });
    assert.strictEqual(passed.exitCode, 0);
    const commands = calls[0].filter((_arg, index, args) => args[index - 1] === "-c");
    const init = commands.indexOf("init");
    assert(commands[init + 1].includes("EP_TARGET_ID") && commands[init + 2] === "echo ok");
    assert.deepStrictEqual(observedTargetIdentity("check-b"), F407);
    const otherLine = `EP_TARGET_ID cpuid=${OTHER_F407.cpuid} idcode=${OTHER_F407.idcode} uid=${OTHER_F407.uid}`;
    await assert.rejects(
        runOpenOcdOnce({
            ...base,
            spawnImpl: fakeSpawn([otherLine, "EP_TARGET_MISMATCH uid", "shutdown command invoked"], 1, calls)
        }),
        (failure) =>
            failure.code === "PROBE_TARGET_MISMATCH" &&
            failure.details.field === "uid" &&
            sameTarget(failure.details.observed, OTHER_F407)
    );
    await runOpenOcdOnce({ ...base, targetCheck: undefined, spawnImpl: fakeSpawn(["ok"], 0, calls) });
    assert(!calls.at(-1).some((arg) => String(arg).includes("EP_TARGET_ID")), "no check outside automatic mode");

    // The workspace record of automatic mode holds a target chip and never a probe.
    assert.deepStrictEqual(
        normalizeSelection({
            version: 3,
            probe: "jlink.cfg",
            probeSerial: "1234",
            deviceId: "usb-1",
            source: "auto",
            target: "stm32f4x.cfg",
            chip: F407
        }),
        {
            version: 3,
            probe: "jlink.cfg",
            probeSerial: "",
            family: "jlink",
            deviceId: "",
            source: "auto",
            target: "stm32f4x.cfg",
            chip: F407
        }
    );
    assert.strictEqual(normalizeSelection({ version: 3, probe: "jlink.cfg", source: "auto", target: "x.cfg" }), null);

    // Several J-Links: automatic mode uses the one connected to the recorded chip.
    const devices = [
        { family: "jlink", serial: "1111", id: "usb-1", attachmentId: "a1" },
        { family: "jlink", serial: "2222", id: "usb-2", attachmentId: "a2" }
    ];
    let boards = { 1111: H750, 2222: F407 };
    let saved = { version: 3, probe: "jlink.cfg", probeSerial: "", source: "auto", target: "stm32f4x.cfg", chip: F407 };
    const identified = [];
    let reveals = 0;
    const service = new ProbeConnectionService({
        getConfig: () => ({ probeSerial: "", transport: "auto" }),
        getSuccessfulConnection: () => saved,
        saveSuccessfulConnection: async (value) => {
            saved = value;
        },
        identifyTarget: async (request) => {
            identified.push(request.probeSerial);
            if (!boards[request.probeSerial]) throw new Error("no target");
            return boards[request.probeSerial];
        },
        onSelectionRequired: () => reveals++,
        prepareConnection: async (request) => ({
            ...resolveProbeConnection(request, { available: true, devices }),
            inventory: { available: true, devices },
            adapterFamily: "jlink"
        })
    });
    const options = { probe: "jlink.cfg", target: "stm32f4x.cfg", executable: "openocd" };
    const picked = await service.prepare(options);
    assert.deepStrictEqual(identified.sort(), ["1111", "2222"], "both probes are read at once");
    assert.strictEqual(picked.deviceId, "usb-2");
    assert.strictEqual(picked.adapterSerial, "2222");
    assert.strictEqual(picked.selection.probe, "target-chip");
    assert.deepStrictEqual(picked.targetCheck.expected, F407);
    assert.strictEqual(picked.targetCheck.deviceId, "usb-2");
    identified.length = 0;
    assert.strictEqual((await service.prepare(options)).deviceId, "usb-2");
    assert.deepStrictEqual(identified, [], "earlier readings settle the next operation without OpenOCD");
    // The boards were swapped: the cached readings point at the old probe; its check reports the mismatch, which
    // drops that probe's reading so the next operation reads again.
    boards = { 1111: F407, 2222: H750 };
    const stale = await service.prepare(options);
    assert.strictEqual(stale.deviceId, "usb-2");
    const error = targetCheckMonitor(stale.targetCheck);
    error.line(`EP_TARGET_ID cpuid=${H750.cpuid} idcode=${H750.idcode} uid=${H750.uid}`);
    error.line("EP_TARGET_MISMATCH uid");
    error.error();
    assert.strictEqual(service.describeTargetState("stm32f4x.cfg").targetMismatch.actual, describeTargetIdentity(H750));
    assert.strictEqual((await service.prepare(options)).deviceId, "usb-1");
    // Without a record, the only chip of the configured model decides.
    saved = null;
    boards = { 1111: F407, 2222: H750 };
    service.targetReadings.clear();
    const byModel = await service.prepare(options);
    assert.deepStrictEqual([byModel.deviceId, byModel.targetCheck.expected], ["usb-1", null]);
    // Two boards of the model and no record: the user picks in the sidebar list, which shows each probe's chip.
    boards = { 1111: F407, 2222: OTHER_F407 };
    service.targetReadings.clear();
    await assert.rejects(service.prepare(options), (failure) => {
        assert.strictEqual(failure.code, "PROBE_SELECTION_REQUIRED");
        assert.strictEqual(failure.i18nKey, "probe.chooseInSidebar");
        assert.deepStrictEqual(
            failure.details.devices.map((device) => device.targetLabel),
            [describeTargetIdentity(F407), describeTargetIdentity(OTHER_F407)]
        );
        return true;
    });
    assert.strictEqual(reveals, 0);
    await assert.rejects(service.prepare(options, true), { code: "PROBE_SELECTION_REQUIRED" });
    assert.strictEqual(reveals, 1, "an interactive operation opens the list instead of prompting");
    assert(describeTargetIdentity(F407).startsWith("STM32F4x · Cortex-M4 · UID …53534C32"));
    assert.strictEqual(saved, null, "nothing is picked for the user");
    // A J-Link on the SEGGER driver cannot be read: the operation reports that driver, so its notification can
    // switch that exact J-Link, instead of asking the user to pick a probe.
    const driverErrors = [];
    service.onDriverUnsupported = (failure) => driverErrors.push(failure);
    const blocked = Object.assign(new Error("SEGGER driver"), {
        code: "PROBE_DRIVER_UNSUPPORTED",
        details: { deviceId: "usb-2", probeSerial: "2222", driverKind: "repair" }
    });
    const identify = service.identifyTarget;
    service.identifyTarget = async (request) => {
        if (request.probeSerial === "2222") throw blocked;
        return identify(request);
    };
    boards = { 1111: H750, 2222: F407 };
    service.targetReadings.clear();
    await assert.rejects(service.prepare(options, true), (failure) => failure === blocked);
    assert.deepStrictEqual(driverErrors, [blocked]);
    assert.strictEqual(reveals, 2, "the list holding every J-Link's driver control is opened");
    // A chip read on the other probe still settles the choice; the blocked probe is then irrelevant.
    boards = { 1111: F407, 2222: F407 };
    service.targetReadings.clear();
    assert.strictEqual((await service.prepare(options)).deviceId, "usb-1");
    assert.strictEqual(driverErrors.length, 1);
    service.identifyTarget = identify;
    service.onDriverUnsupported = () => {};
    // A probe named by the workspace or the settings is used as named, without a target check.
    saved = { version: 3, probe: "jlink.cfg", probeSerial: "1111", source: "user" };
    assert.strictEqual((await service.prepare(options)).targetCheck, undefined);
    saved = null;
    assert.strictEqual((await service.prepare({ ...options, probeSerial: "2222" })).targetCheck, undefined);
    service.dispose();

    console.log("Target chip identity and automatic-mode check tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
