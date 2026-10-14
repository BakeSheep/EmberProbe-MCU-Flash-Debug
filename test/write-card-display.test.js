"use strict";

const assert = require("assert");
const runtime = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

assert.deepStrictEqual(runtime.uniqueShortVariableNames(["app::group::counter", "plant.value"]), [
    ".counter",
    ".value"
]);
assert.deepStrictEqual(
    runtime.uniqueShortVariableNames(["chassis.motor[0].pid.Ref", "chassis.motor[1].pid.Ref", "gimbal.Ref", "speed"]),
    [".motor[0].pid.Ref", ".motor[1].pid.Ref", "gimbal.Ref", "speed"]
);
assert.deepStrictEqual(runtime.uniqueShortVariableNames(["ns::a::x", "ns::b::x"]), [".a::x", ".b::x"]);
assert.deepStrictEqual(
    runtime.uniqueShortVariableNames(["a.Ref", "Ref"]),
    ["a.Ref", "Ref"],
    "a full name keeps no leading dot"
);
assert.deepStrictEqual(runtime.uniqueShortVariableNames(["same", "same"]), ["same", "same"], "identical names stop");

const symbols = [
    { name: "dbg_lb_ref", address: 0x20000000, size: 4, watchType: "f32", hasDwarfWriteType: true },
    { name: "count", address: 0x20000004, size: 4, watchType: "u32", hasDwarfWriteType: true },
    { name: "level", address: 0x20000008, size: 4, watchType: "u16", hasDwarfWriteType: true }
];
const motor = (name, address) => ({
    name,
    address,
    size: 4,
    isComposite: true,
    compositeLayout: { kind: "struct", members: [{ name: "Ref", offset: 0, byteSize: 4, watchType: "f32" }] }
});
const view = render(getModernWebviewContent({}, "en"));
try {
    view.send({
        type: "availableVariables",
        symbols: [...symbols, motor("motor_lf", 0x20000010), motor("motor_rf", 0x20000014)]
    });
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true, haltWrite: true });
    const box = view.document.getElementById("availableVars");
    for (const button of box.querySelectorAll(".available-row:not(.comp) .av-write")) button.click();
    for (const arrow of box.querySelectorAll(".av-arrow")) arrow.click();
    for (const button of box.querySelectorAll(".available-row.leaf .av-write")) button.click();
    const card = (name) =>
        Array.from(view.document.querySelectorAll(".write-row")).find(
            (row) => row.querySelector(".value-name").dataset.rawName === name
        );
    const label = (name) => card(name).querySelector(".value-name").textContent;
    assert.strictEqual(label("motor_lf.Ref"), "motor_lf.Ref", "colliding members show their parent");
    assert.strictEqual(label("motor_rf.Ref"), "motor_rf.Ref");
    assert.strictEqual(label("dbg_lb_ref"), "dbg_lb_ref");
    assert.strictEqual(card("motor_lf.Ref").querySelector(".value-name").title, "motor_lf.Ref");
    card("motor_rf.Ref").querySelector(".watch-remove").click();
    assert.strictEqual(label("motor_lf.Ref"), ".Ref", "labels shrink once the collision is gone");

    // Added before the first sample: f32 starts at [-1, 1], then follows the sampled value.
    const bounds = (name) => Array.from(card(name).querySelectorAll(".bound"), (el) => el.textContent);
    const slider = (name) => card(name).querySelector(".write-slider");
    assert.deepStrictEqual(bounds("dbg_lb_ref"), ["-1", "1"]);
    view.send({
        type: "liveSample",
        samples: [
            { name: "dbg_lb_ref", value: -567.2 },
            { name: "count", value: 4000000000 },
            { name: "level", value: 7 }
        ]
    });
    assert.strictEqual(Number(slider("dbg_lb_ref").min), -1134.4);
    assert.strictEqual(Number(slider("dbg_lb_ref").max), 1);
    assert.strictEqual(Number(slider("dbg_lb_ref").value), -567.2, "the thumb is no longer pinned to a bound");
    assert.notDeepStrictEqual(bounds("dbg_lb_ref"), ["-1", "1"]);
    assert.strictEqual(Number(slider("count").max), 4294967295, "integer bounds stay inside the type range");
    assert.strictEqual(Number(slider("count").value), 4000000000);
    assert.strictEqual(Number(slider("level").max), 65535, "in-range values keep their bounds");
    const saved = view.messages.findLast((message) => message.type === "saveSidebarWrite").items;
    assert.strictEqual(saved.find((item) => item.name === "dbg_lb_ref").min, -1134.4, "widened bounds persist");

    // A user range that still contains the value is left alone.
    view.send({ type: "liveSample", samples: [{ name: "dbg_lb_ref", value: -10 }] });
    assert.strictEqual(Number(slider("dbg_lb_ref").min), -1134.4);
    view.assertHealthy();
} finally {
    view.close();
}
console.log("Write card unique labels and slider bound widening passed");
