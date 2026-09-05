"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const runtime = require("../src/webview/runtime");
const { connect } = require("../src/webview/messages");
const { render } = require("../src/webview/sidebar/chipView");
for (const [size, type] of [
    [1, "u8"],
    [2, "u16"],
    [4, "u32"],
    [8, "u64"],
    [99, "u32"]
]) {
    assert.strictEqual(runtime.defaultType(size), type);
    assert.strictEqual(runtime.typeByteLength(type), size === 99 ? 4 : size);
}
assert.strictEqual(runtime.typeByteLength("unknown"), 4);
assert.strictEqual(
    runtime.translate({ en: { hello: "Hello {name}" }, zh: { fallback: "中文" } }, "en", "hello", { name: "Ada" }),
    "Hello Ada"
);
assert.strictEqual(runtime.translate({ zh: { fallback: "中文" } }, "fr", "fallback"), "中文");
assert.strictEqual(runtime.translate({}, "en", "unknown"), "unknown");
assert.strictEqual(runtime.translate({ zh: { hello: "Hello {name}" } }, "en", "hello"), "Hello ");
assert.deepStrictEqual(runtime.liveState({ running: true, canRead: true, canWrite: true }, {}), {
    running: true,
    canRead: true,
    canWrite: true,
    fresh: false
});
for (const message of [
    { source: "dap", snapshotReady: true },
    { source: "openocd", canRead: true }
])
    assert.strictEqual(runtime.liveState({}, message).fresh, true);
assert.strictEqual(runtime.liveState({}, { intentEnabled: false, running: true, canWrite: false }).running, false);
assert.strictEqual(runtime.liveState({}, { running: true }).running, true);
const dom = new JSDOM("<main></main>");
try {
    let received = 0;
    const disconnect = connect(dom.window, { update: (m) => (received += m.value) });
    for (const data of [
        null,
        "update",
        { type: 1 },
        { type: "toString" },
        { type: "missing" },
        { type: "update", value: 2 }
    ])
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
    assert.strictEqual(received, 2);
    disconnect();
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "update", value: 2 } }));
    assert.strictEqual(received, 2);
    const opts = {
        t: (key, params) => key + (params?.vendor || ""),
        icon: "",
        states: { halted: "Halted" },
        moreOpen: true
    };
    for (const info of [
        null,
        {
            core: "<script>bad</script>",
            targetState: "halted",
            uid: '"&<>',
            authenticity: "compatible",
            endian: "little",
            designerCode: "JEP106 123",
            voltage: "3V"
        },
        { authenticity: "genuine", endian: "big", probe: "DAP", romDesigner: "ARM", designerCode: "123" },
        { endian: "native", targetState: "running", compatBrand: "X" }
    ]) {
        const main = dom.window.document.querySelector("main");
        main.innerHTML = render(info, opts);
        assert.strictEqual(main.querySelector("script"), null);
        assert.ok(main.querySelector("#chipMore").open);
    }
} finally {
    dom.window.close();
}
console.log("Shared Webview state, routing and presentation tests passed");
