"use strict";

const assert = require("node:assert/strict");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

function fixture() {
    const view = render(getModernWebviewContent({ backend: "probe-rs" }, "en"));
    const context = { sessionId: "probe-rs-a", stopEpoch: 3 };
    const timers = new Map();
    let now = 10000;
    let nextTimer = 0;
    view.window.Date.now = () => now;
    view.window.setTimeout = (run, delay) => {
        timers.set(++nextTimer, { run, at: now + delay });
        return nextTimer;
    };
    view.window.clearTimeout = (id) => timers.delete(id);
    const state = {
        ...view,
        status(extra = {}) {
            view.send({
                type: "liveStatus",
                source: "dap",
                running: true,
                canRead: true,
                canWrite: true,
                snapshotReady: true,
                writeBlockedReason: "",
                writeContext: context,
                ...extra
            });
        },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!due || due[1].at > end) break;
                now = due[1].at;
                timers.delete(due[0]);
                due[1].run();
            }
            now = end;
        },
        drag(value, index = 0, final = false) {
            const slider = view.document.querySelectorAll(".write-slider")[index];
            slider.value = String(value);
            slider.dispatchEvent(new view.window.Event(final ? "change" : "input"));
        },
        writes() {
            return view.messages.filter((message) => message.type === "writeVariable");
        },
        result(request, extra = {}) {
            view.send({ ...request, type: "writeResult", ok: true, ...extra });
        }
    };
    state.status();
    view.send({
        type: "sidebarWriteList",
        items: ["GAIN", "TUNE"].map((name, index) => ({
            name,
            address: 0x20000000 + index * 4,
            size: 4,
            type: "f32",
            value: 0,
            min: -1,
            max: 1
        }))
    });
    return state;
}

const slow = fixture();
try {
    slow.drag(0.1);
    const first = slow.writes()[0];
    assert.deepEqual(first.writeContext, { sessionId: "probe-rs-a", stopEpoch: 3 });
    slow.status({ canWrite: false, writeBlockedReason: "writing" });
    const slider = slow.document.querySelector(".write-slider");
    assert.equal(slider.disabled, false);
    for (let index = 2; index <= 9; index++) {
        slow.drag(index / 10);
        slow.advance(130);
    }
    slow.drag(0.9, 0, true);
    slow.drag(-0.3, 1);
    assert.equal(slow.writes().length, 1, "slow writes must never overlap or build a stale-value backlog");
    assert.equal(slow.document.getElementById("writeFeedback").textContent, "");
    slow.send({ type: "liveSample", samples: [{ name: "GAIN", value: 0.1 }] });
    slow.result(first, { value: 0.100000001 });
    assert.equal(slider.value, "0.9", "a previous readback must not overwrite the newest drag value");
    assert(slow.document.querySelector(".write-input").classList.contains("pending"));
    slow.status({ canWrite: false, snapshotReady: false, writeBlockedReason: "snapshot" });
    assert.equal(slow.writes().length, 1, "queued writes wait quietly for the current sample");
    assert.equal(slider.disabled, false);
    slow.status();
    const final = slow.writes()[1];
    assert.equal(final.value, 0.9);
    slow.drag(0.9, 0, true);
    slow.result(final);
    slow.advance(100);
    const other = slow.writes()[2];
    assert.equal(other.name, "TUNE");
    assert.equal(other.value, -0.3);
    slow.result(first, { value: 0.1 });
    assert.equal(slow.writes().length, 3, "late replies must not release the next variable's in-flight request");
    slow.result(other);
    slow.advance(1000);
    assert.equal(slow.writes().length, 3, "mouse-up must not duplicate an identical in-flight value");
    assert.equal(slider.value, "0.9");
    assert(!slow.document.querySelector(".write-input").classList.contains("pending"));
    slow.assertHealthy();
} finally {
    slow.close();
}

const fast = fixture();
try {
    fast.drag(0.1);
    fast.drag(0.2);
    fast.result(fast.writes()[0]);
    fast.advance(99);
    assert.equal(fast.writes().length, 1, "fast replies retain the 10 Hz drag budget");
    fast.advance(1);
    assert.equal(fast.writes()[1].value, 0.2);
    fast.result(fast.writes()[1]);
    fast.drag(0.4, 0, true);
    assert.equal(fast.writes()[2].value, 0.4, "mouse-up submits the final value without another throttle delay");
} finally {
    fast.close();
}

for (const invalidate of [
    (view) => view.status({ running: false, intentEnabled: false, canWrite: false, writeBlockedReason: "sampling" }),
    (view) => view.status({ writeContext: { sessionId: "probe-rs-b", stopEpoch: 3 } }),
    (view) => view.status({ writeContext: { sessionId: "probe-rs-a", stopEpoch: 4 } }),
    (view) => view.status({ canWrite: false, writeBlockedReason: "transition" }),
    (view) => view.status({ canWrite: false, writeBlockedReason: "unsupported" }),
    (view) => view.status({ error: true, canWrite: false, writeBlockedReason: "snapshot" }),
    (view) => view.send({ type: "sidebarWriteList", items: [] }),
    (view) => view.document.querySelector(".write-row .watch-remove").click()
]) {
    const view = fixture();
    try {
        view.drag(0.1);
        view.drag(0.8, 0, true);
        invalidate(view);
        view.result(view.writes()[0]);
        view.status();
        view.advance(1000);
        assert.equal(view.writes().length, 1, "invalidated drag values must not be replayed on a later target");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

const changed = fixture();
try {
    changed.drag(0.1);
    const old = changed.writes()[0];
    changed.status({ writeContext: { sessionId: "probe-rs-b", stopEpoch: 4 } });
    changed.drag(0.1, 0, true);
    assert.equal(changed.writes().length, 1, "a cancelled old request retains the in-flight lock until acknowledged");
    changed.result(old);
    assert.equal(changed.writes().length, 2, "a fresh gesture on a new session must not deduplicate a cancelled value");
    assert.deepEqual(changed.writes()[1].writeContext, { sessionId: "probe-rs-b", stopEpoch: 4 });
    changed.result(changed.writes()[1]);
    changed.assertHealthy();
} finally {
    changed.close();
}

const failed = fixture();
try {
    failed.drag(0.1);
    failed.status({ canWrite: false, writeBlockedReason: "writing" });
    failed.drag(0.7, 0, true);
    failed.result(failed.writes()[0], { ok: false, message: "Write verification failed" });
    failed.status();
    failed.advance(1000);
    assert.equal(failed.writes().length, 1, "failed writes and queued values must not be retried automatically");
    assert.match(failed.document.getElementById("writeFeedback").textContent, /Write verification failed/);
    failed.drag(0.8, 0, true);
    assert.equal(failed.writes()[1].value, 0.8, "a new explicit gesture can write after a reported failure");
    failed.assertHealthy();
} finally {
    failed.close();
}

console.log("Slider write serialization, newest values, throttle, quiet busy states and context cancellation passed");
