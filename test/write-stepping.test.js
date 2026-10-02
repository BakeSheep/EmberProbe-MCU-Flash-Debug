"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { encodeValue, decodeValue } = require("../src/elfSymbols");

const view = render(getModernWebviewContent({}, "en"));
try {
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true });
    function load(type, value, extra = {}) {
        view.send({
            type: "sidebarWriteList",
            items: [{ name: "value", address: 536870912, type, value, min: -1, max: 1, ...extra }]
        });
        return view.document.querySelector(".write-input");
    }
    function wheel(element, deltaY) {
        element.dispatchEvent(new view.window.WheelEvent("wheel", { deltaY, cancelable: true }));
    }
    function saved() {
        return view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
    }
    for (const type of ["f32", "f64"]) {
        for (const sign of [1, -1]) {
            const input = load(type, decodeValue(encodeValue(sign * 0.001, type), type));
            wheel(input, sign);
            assert.strictEqual(saved().value, 0, `${type} should step to exact zero from a sampled decimal`);
            assert.strictEqual(input.value, "0");
            assert.strictEqual(decodeValue(encodeValue(saved().value, type), type), 0);
            wheel(input, sign);
            assert.strictEqual(saved().value, -sign * 0.001, `${type} should continue across zero`);
        }
        const input = load(type, decodeValue(encodeValue(0.01, type), type));
        for (let count = 0; count < 10; count++) wheel(input, 1);
        assert.strictEqual(saved().value, 0, `${type} should not accumulate residuals in repeated steps`);
        load(type, decodeValue(encodeValue(0.001, type), type));
        view.document.querySelector(".step-btn").click();
        assert.strictEqual(saved().value, 0, `${type} minus button should match wheel stepping`);
        load(type, 0.00123456789);
        const unchangedInput = view.document.querySelector(".write-input");
        const messageCount = view.messages.length;
        unchangedInput.dispatchEvent(new view.window.FocusEvent("blur"));
        assert.strictEqual(view.messages.length, messageCount, "unchanged rounded text must not trigger a write");
        view.document.querySelectorAll(".step-btn")[1].click();
        assert.ok(Math.abs(saved().value - 0.00223456789) < 1e-17, "buttons should preserve undisplayed digits");
        load(type, 0.0004);
        wheel(view.document.querySelector(".write-input"), 1);
        assert.ok(Math.abs(saved().value + 0.0006) < 1e-17, "off-grid values should keep their fractional offset");
        load(type, 1e-8);
        wheel(view.document.querySelector(".write-input"), -1);
        assert.ok(Math.abs(saved().value - 0.00100001) < 1e-17, "small genuine offsets must survive stepping");
        const edited = load(type, 0);
        edited.value = "0.005";
        wheel(edited, 1);
        assert.strictEqual(saved().value, 0.004, "wheel stepping must use pending input edits");
        load(type, 0.001, { min: 0.001 });
        wheel(view.document.querySelector(".bound"), 1);
        assert.strictEqual(saved().min, 0, "bound wheels should also remove representation noise");
    }
    load("f64", 0);
    view.document.querySelector(".bound").click();
    const bound = view.document.querySelector(".bound-input");
    bound.value = "-0.125";
    bound.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
    assert.strictEqual(saved().min, -0.125, "f64 bounds must retain fractions");

    for (const [type, min, max] of [
        ["u8", 0, 255],
        ["i8", -128, 127],
        ["u16", 0, 65535],
        ["i16", -32768, 32767],
        ["u32", 0, 4294967295],
        ["i32", -2147483648, 2147483647]
    ]) {
        wheel(load(type, 1), 1);
        assert.strictEqual(saved().value, 0);
        wheel(load(type, max), -1);
        assert.strictEqual(saved().value, max, `${type} must clamp at its maximum`);
        wheel(load(type, min), 1);
        assert.strictEqual(saved().value, min, `${type} must clamp at its minimum`);
    }
    wheel(load("u8", 1, { isBoolean: true }), 1);
    assert.strictEqual(saved().value, 0);
    wheel(view.document.querySelector(".write-input"), 1);
    assert.strictEqual(saved().value, 0, "booleans stay in the 0/1 range");
    for (const [type, value] of [
        ["u64", "18446744073709551615"],
        ["i64", "-9223372036854775808"]
    ]) {
        const input = load(type, "0");
        input.value = value;
        input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
        assert.strictEqual(saved().value, value, "wide integers must remain exact decimal strings");
        assert.ok(view.document.querySelector(".step-btn").hidden);
        const count = view.messages.length;
        wheel(input, 1);
        assert.strictEqual(view.messages.length, count, "wide integers have no numeric wheel handler");
    }
    view.assertHealthy();
    console.log("Write stepping, floating bounds and integer precision regressions passed");
} finally {
    view.close();
}
