"use strict";
const assert = require("assert");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { isFatalProbeLog } = require("../src/openocdProcess");
const i18n = require("../src/i18n");
const { scenario } = require("./helpers/scenario");

scenario("A native CMSIS-DAP transport failure aborts once instead of retrying reads", () => {
    for (const line of [
        "Debug: error reading adapter response",
        "CMSIS-DAP command mismatch. Expected 0x5 received 0x0"
    ]) {
        const events = [];
        const session = new ManagedOpenOcdSession({}, { onDisconnect: (error) => events.push(error) });
        let rejection;
        session.tcl.queue.push({
            reject: (error) => {
                rejection = error;
            }
        });
        session._handleServerLog(line, { line: () => false });
        session._handleServerLog(line, { line: () => false });
        assert.strictEqual(events.length, 1);
        assert.strictEqual(rejection.code, "PROBE_COMMUNICATION_FAILED");
        assert.strictEqual(session.stopped, true);
        assert.strictEqual(session.tcl.queue.length, 0);
    }
    assert.strictEqual(isFatalProbeLog("Debug: SWD ack not OK @ 0 WAIT"), false);
    assert.strictEqual(isFatalProbeLog("Debug: USB timeout @ 0"), false, "startup drain uses a short timeout normally");
    assert.strictEqual(
        isFatalProbeLog("Debug: SWD ack not OK @ 0 JUNK"),
        false,
        "startup negotiation may probe dormant mode"
    );
});
// A lost connection stops sampling once and rejects the whole FIFO, so late responses cannot leak into the next
// request.
let disconnects = 0;
let rejected = 0;
const session = new ManagedOpenOcdSession(
    {},
    {
        onDisconnect: () => {
            disconnects++;
        }
    }
);
session.tcl.queue.push(
    {
        reject: () => {
            rejected++;
        }
    },
    {
        reject: () => {
            rejected++;
        }
    }
);
session._abortConnection(new Error("timeout"));
session._abortConnection(new Error("duplicate"));
assert.strictEqual(session.stopped, true);
assert.strictEqual(session.tcl.queue.length, 0);
assert.strictEqual(rejected, 2);
assert.strictEqual(disconnects, 1);

// An abort while start() runs rejects the start promise instead of calling onDisconnect, avoiding a double notification
let startErr = null;
const session2 = new ManagedOpenOcdSession(
    {},
    {
        onDisconnect: () => {
            disconnects++;
        }
    }
);
session2._startReject = (err) => {
    startErr = err;
};
session2._abortConnection(new Error("child exited during connect"));
assert.ok(
    startErr && startErr.message === "child exited during connect",
    "start promise should be rejected with the abort reason"
);
assert.strictEqual(session2._startReject, null, "_startReject should be cleared after deferral");
assert.strictEqual(disconnects, 1, "onDisconnect must not fire while start is in flight");

let connectingSocketDestroyed = 0;
const session3 = new ManagedOpenOcdSession({}, {});
session3.connectingSocket = {
    destroyed: false,
    destroy() {
        this.destroyed = true;
        connectingSocketDestroyed++;
    }
};
session3.stop();
assert.strictEqual(connectingSocketDestroyed, 1, "stopping during startup must close the in-flight socket");
assert.strictEqual(session3.connectingSocket, null);

// Probe unplugged while sampling: fatal logs such as USB read/write failures count as a disconnect, so sampling stops
// automatically
assert.ok(
    isFatalProbeLog("Error: error writing data: WriteFile: (0x0000048F)"),
    "USB WriteFile failure must be treated as a debugger disconnect"
);
assert.ok(
    isFatalProbeLog("libusb_bulk_write LIBUSB_ERROR_NO_DEVICE"),
    "libusb no-device must be treated as a disconnect"
);
assert.ok(!isFatalProbeLog("Info : clock speed 4000 kHz"), "benign info logs must not trigger auto-stop");
assert.ok(
    !isFatalProbeLog("Error: timed out while waiting for target halted"),
    "non-link errors must not trigger auto-stop"
);
// Automatic language: the default UI language follows the VS Code display language (zh-* -> Chinese, anything else ->
// English)
assert.strictEqual(i18n.matchVscodeLang("zh-cn"), "zh", "Chinese VS Code locale should map to zh");
assert.strictEqual(i18n.matchVscodeLang("zh-tw"), "zh", "Traditional Chinese locale should map to zh");
assert.strictEqual(i18n.matchVscodeLang("en"), "en", "English locale should map to en");
assert.strictEqual(i18n.matchVscodeLang("ja"), "en", "non-Chinese locales should fall back to en");
assert.strictEqual(i18n.matchVscodeLang(undefined), "en", "missing locale should fall back to en");

scenario("Debug session tolerates recoverable mismatches during tentative download boost", () => {
    const { ManagedOpenOcdSession } = require("../src/liveWatch");
    const events = [];
    const makeSession = () =>
        new ManagedOpenOcdSession(
            {
                executable: "openocd",
                probe: "cmsis-dap.cfg",
                target: "stm32h7x.cfg",
                port: 6666,
                gdbPort: 3333,
                mode: "debug"
            },
            { onDisconnect: (err) => events.push(err) }
        );

    const session = makeSession();
    const targetCheck = { line: () => false };
    session._handleServerLog("EP_FLASH_STAGE=program_boost", targetCheck);
    assert.strictEqual(session._tentativeDownloadBoost, true);
    for (const line of [
        "Error: CMSIS-DAP command mismatch. Expected 0x6 received 0x5",
        "Error: CMSIS-DAP transfer count mismatch: expected 22, got 0",
        "Error: Target communication error"
    ]) {
        session._handleServerLog(line, targetCheck);
        assert.strictEqual(session.stopped, false, line);
        assert.strictEqual(session.connectionFailed, false, line);
        assert.strictEqual(events.length, 0, line);
        assert(session.server.logTail.includes(line), line);
    }

    session._handleServerLog("EP_FLASH_STAGE=program", targetCheck);
    assert.strictEqual(session._tentativeDownloadBoost, false);
    session._handleServerLog("Error: CMSIS-DAP command mismatch. Expected 0x6 received 0x5", targetCheck);
    assert.strictEqual(session.connectionFailed, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].code, "PROBE_COMMUNICATION_FAILED");

    events.length = 0;
    const usbFailureSession = makeSession();
    usbFailureSession._handleServerLog("EP_FLASH_STAGE=program_boost", targetCheck);
    usbFailureSession._handleServerLog(
        "Error: error writing data: hid_write/WaitForSingleObject: (0x000003E5)",
        targetCheck
    );
    assert.strictEqual(usbFailureSession.connectionFailed, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].code, "PROBE_COMMUNICATION_FAILED");
});

console.log("Webview & live session tests passed");
