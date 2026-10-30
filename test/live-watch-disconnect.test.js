"use strict";
const assert = require("assert");
const { LiveWatchSession } = require("../src/liveWatch");
const i18n = require("../src/i18n");
// A lost connection stops sampling once and rejects the whole FIFO, so late responses cannot leak into the next
// request.
let disconnects = 0;
let rejected = 0;
const session = new LiveWatchSession(
    null,
    {},
    {
        onDisconnect: () => {
            disconnects++;
        }
    }
);
session.queue.push(
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
assert.strictEqual(session.queue.length, 0);
assert.strictEqual(rejected, 2);
assert.strictEqual(disconnects, 1);

// An abort while start() runs rejects the start promise instead of calling onDisconnect, avoiding a double notification
let startErr = null;
const session2 = new LiveWatchSession(
    null,
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
const session3 = new LiveWatchSession(null, {}, {});
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
const probeGone = new LiveWatchSession(null, {}, {});
assert.ok(
    probeGone._isFatalProbeLog("Error: error writing data: WriteFile: (0x0000048F)"),
    "USB WriteFile failure must be treated as a debugger disconnect"
);
assert.ok(
    probeGone._isFatalProbeLog("libusb_bulk_write LIBUSB_ERROR_NO_DEVICE"),
    "libusb no-device must be treated as a disconnect"
);
assert.ok(!probeGone._isFatalProbeLog("Info : clock speed 4000 kHz"), "benign info logs must not trigger auto-stop");
assert.ok(
    !probeGone._isFatalProbeLog("Error: timed out while waiting for target halted"),
    "non-link errors must not trigger auto-stop"
);
// Automatic language: the default UI language follows the VS Code display language (zh-* -> Chinese, anything else ->
// English)
assert.strictEqual(i18n.matchVscodeLang("zh-cn"), "zh", "Chinese VS Code locale should map to zh");
assert.strictEqual(i18n.matchVscodeLang("zh-tw"), "zh", "Traditional Chinese locale should map to zh");
assert.strictEqual(i18n.matchVscodeLang("en"), "en", "English locale should map to en");
assert.strictEqual(i18n.matchVscodeLang("ja"), "en", "non-Chinese locales should fall back to en");
assert.strictEqual(i18n.matchVscodeLang(undefined), "en", "missing locale should fall back to en");

console.log("Webview & live session tests passed");
