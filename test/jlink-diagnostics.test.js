"use strict";
const assert = require("assert");
const { MessageChannel } = require("worker_threads");
const { once } = require("events");
const { run } = require("../src/samplingWorker");
const { deserializeError, serializeError } = require("../src/services/errorEnvelope");
const { diagnoseOpenOcdFailure, parseTargetVoltage } = require("../skills/_emberprobe/openocd-diagnostics");
const { parseLine } = require("../src/openocdRunner");
const { createChipParser } = require("../src/chip/parser");

(async () => {
    const sensitive = serializeError(
        Object.assign(new Error(require("os").homedir() + "/project token=abc"), {
            details: { token: "abc", openocdTail: ["password=abc"] }
        })
    );
    assert(!JSON.stringify(sensitive).includes("abc"));
    assert(!sensitive.message.includes(require("os").homedir()));
    const details = { probe: "jlink.cfg", platform: "win32" };
    for (const [line, code] of [
        ["Error: No J-Link device found", "PROBE_NOT_FOUND"],
        ["Error: Failed to open device: unspecified error", "PROBE_OPEN_FAILED"],
        ["Error: LIBUSB_ERROR_NOT_SUPPORTED", "PROBE_DRIVER_UNSUPPORTED"],
        ["Error: LIBUSB_ERROR_BUSY", "PROBE_BUSY"],
        ["Info : VTarget = 0.000 V", "TARGET_UNPOWERED"]
    ])
        assert.strictEqual(diagnoseOpenOcdFailure([line, "Error: init failed"], details).code, code);
    assert(!diagnoseOpenOcdFailure(["LIBUSB_ERROR_BUSY"], details).suggestedActions.join(" ").includes("驱动"));
    assert(!diagnoseOpenOcdFailure(["LIBUSB_ERROR_ACCESS"], details).suggestedActions.join(" ").includes("替换"));
    assert.strictEqual(parseTargetVoltage("VTarget = unknown"), null);
    assert.strictEqual(parseLine("Info : VTarget = 3.300 V").volts, 3.3);
    const parser = createChipParser("stm32f1x.cfg");
    for (const line of [
        "Info : J-Link OB compiled Sep 20 2020",
        "Info : Hardware version: 9.00",
        "Info : VTarget = 3.300 V"
    ])
        parser.handleLine(line);
    const info = parser.finish(0);
    assert.strictEqual(info.probeHardwareVersion, "9.00");
    assert.strictEqual(info.voltage, "3.30 V");
    assert(info.probeFirmware.includes("compiled"));

    const { port1, port2 } = new MessageChannel();
    let handlers;
    const diagnostic = diagnoseOpenOcdFailure(["LIBUSB_ERROR_NOT_SUPPORTED"], details);
    const error = Object.assign(new Error(diagnostic.message), diagnostic, {
        i18nKey: "live.serviceExited",
        i18nParams: { code: 1, port: 6666 }
    });
    run(port1, {}, (_config, nextHandlers) => {
        handlers = nextHandlers;
        return {
            stopped: false,
            samplingEnabled: false,
            start: async () => {
                throw error;
            },
            stop() {}
        };
    });
    try {
        const response = once(port2, "message");
        port2.postMessage({ id: 1, method: "start", args: [] });
        const [message] = await response;
        assert.deepStrictEqual(message.error.suggestedActions, error.suggestedActions);
        for (const name of ["onDisconnect", "onDegraded"]) {
            const event = once(port2, "message");
            handlers[name](error);
            const [received] = await event;
            const restored = deserializeError(received.args[0]);
            for (const field of [
                "code",
                "category",
                "stage",
                "details",
                "suggestedActions",
                "retryable",
                "i18nKey",
                "i18nParams"
            ])
                assert.deepStrictEqual(restored[field], error[field], name + ": " + field);
        }
    } finally {
        port1.close();
        port2.close();
    }
    console.log("J-Link native logs and worker diagnostics passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
