"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { encodeValue, decodeValue } = require("../src/elfSymbols");

const view = render(getModernWebviewContent({}, "en"));
(async () => {
    try {
        view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true });
        function load(type, value, extra = {}) {
            view.send({
                type: "sidebarWriteList",
                items: [{ name: "value", address: 536870912, type, value, min: -1, max: 1, ...extra }]
            });
            return view.document.querySelector(".write-input");
        }
        function wheel(element, deltaY, focus = true) {
            // Value boxes step only while focused; bound labels have no focus requirement.
            if (focus && element.classList.contains("write-input")) element.focus();
            const event = new view.window.WheelEvent("wheel", { deltaY, cancelable: true });
            element.dispatchEvent(event);
            return event;
        }
        function saved() {
            return view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
        }
        {
            const input = load("u32", 5);
            input.blur();
            const count = view.messages.length;
            const event = wheel(input, -1, false);
            assert.strictEqual(view.messages.length, count, "scrolling across an unfocused value box must not write");
            assert.strictEqual(event.defaultPrevented, false, "an unfocused value box lets the panel scroll");
            assert.strictEqual(input.value, "5");
            wheel(input, -1);
            assert.strictEqual(saved().value, 6, "a focused value box still steps with the wheel");
            const request = view.messages.findLast((message) => message.type === "writeVariable");
            assert.strictEqual(request.value, 6);
            view.send({ ...request, type: "writeResult", ok: false, message: "rejected" });
            assert.strictEqual(input.value, "5", "without samples a failed write restores the last confirmed value");
            assert.strictEqual(saved().value, 5);
            input.blur();
        }
        // Typed values are written exactly or rejected; never clamped, rounded or emptied into 0.
        for (const [type, text, extra] of [
            ["u32", "-1"],
            ["u8", "5000"],
            ["i16", "1.5"],
            ["u8", "2", { isBoolean: true }],
            ["u32", ""],
            ["u32", "   "]
        ]) {
            const input = load(type, 1, extra);
            const writes = view.messages.filter((message) => message.type === "writeVariable").length;
            input.focus();
            input.value = text;
            input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
            assert.strictEqual(
                view.messages.filter((message) => message.type === "writeVariable").length,
                writes,
                `${type} must not write ${JSON.stringify(text)}`
            );
            assert.strictEqual(input.value, "1", "the previous value is shown again");
            if (text.trim())
                assert.match(view.document.querySelector("#noticeWrite .notice-text").textContent, /^Not written/);
            input.blur();
        }
        {
            const input = load("u8", 1);
            input.focus();
            input.value = "255";
            input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
            assert.strictEqual(view.messages.findLast((message) => message.type === "writeVariable").value, 255);
            input.blur();
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
        // While the debugger holds the target halted, a drag writes only the value it settles on.
        {
            view.send({
                type: "liveStatus",
                running: true,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                mode: "debug-paused-ready"
            });
            load("u8", 0, { min: 0, max: 100 });
            const slider = view.document.querySelector(".write-slider");
            const writes = () => view.messages.filter((message) => message.type === "writeVariable");
            const before = writes().length;
            for (const value of [10, 20, 30]) {
                slider.value = String(value);
                slider.dispatchEvent(new view.window.Event("input"));
            }
            assert.strictEqual(writes().length, before, "paused drags do not write intermediate values");
            slider.dispatchEvent(new view.window.Event("change"));
            assert.strictEqual(writes().length, before + 1, "releasing the slider writes at once");
            assert.strictEqual(writes().at(-1).value, 30);
            slider.value = "40";
            slider.dispatchEvent(new view.window.Event("input"));
            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.strictEqual(writes().length, before + 2, "a held slider writes once it settles");
            assert.strictEqual(writes().at(-1).value, 40);
        }
        view.assertHealthy();
        console.log("Write stepping, floating bounds and integer precision regressions passed");
    } finally {
        view.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
