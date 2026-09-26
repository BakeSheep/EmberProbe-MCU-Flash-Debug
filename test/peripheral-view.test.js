"use strict";

const assert = require("assert");
const { PeripheralViewService } = require("../src/services/peripheralViewService");
const { getModernWebviewContent } = require("../src/modernView");
const { render } = require("./helpers/render-webview");
const { loadProvider } = require("./helpers/load-provider");

(async () => {
    let epoch = 1;
    const bridge = {
        assertPausedAccess() {},
        agentStatus: () => ({ epoch, session: { id: "debug-1" } })
    };
    const register = {
        name: "MODER",
        path: "GPIOA.MODER",
        description: "Mode register",
        addressText: "0x40020000",
        size: 32,
        access: "read-write",
        fields: [
            {
                name: "MODE0",
                path: "GPIOA.MODER.MODE0",
                bitOffset: 0,
                bitWidth: 2,
                access: "read-write",
                enumerations: []
            }
        ]
    };
    const peripherals = {
        model: async () => ({
            svd: { device: "TEST", sha256: "abc", path: "/device.svd" },
            peripherals: [
                {
                    name: "GPIOA",
                    description: "GPIO port A",
                    baseAddressText: "0x40020000",
                    registers: [register]
                }
            ]
        }),
        list: async () => ({ peripherals: [{ name: "GPIOA", registers: [register] }] }),
        read: async ({ targets }) => {
            if (targets[0] === "GPIOA.STATUS")
                throw Object.assign(new Error("read clears status"), { code: "PERIPHERAL_READ_SIDE_EFFECT" });
            return {
                registers: [
                    {
                        path: targets[0],
                        value: "0x00000002",
                        fields: [{ path: "GPIOA.MODER.MODE0", value: "0x2", enum: "Alternate" }]
                    }
                ]
            };
        }
    };
    const service = new PeripheralViewService({ peripherals, debugBridge: bridge });
    const catalog = await service.catalog();
    assert.strictEqual(catalog.peripherals[0].registerNames[0], "MODER");
    assert.strictEqual((await service.registers("GPIOA")).registers[0].path, "GPIOA.MODER");
    await assert.rejects(service.registers("MISSING"), /not found/);
    const result = await service.read(["GPIOA.MODER", "GPIOA.STATUS"]);
    assert.strictEqual(result.registers[0].value, "0x00000002");
    assert.strictEqual(result.registers[1].code, "PERIPHERAL_READ_SIDE_EFFECT");
    await assert.rejects(service.read([]), /register paths/);
    await assert.rejects(service.read(Array(33).fill("GPIOA.MODER")), /register paths/);
    peripherals.read = async () => {
        epoch++;
        return { registers: [{ path: "GPIOA.MODER", value: "0x00000002" }] };
    };
    await assert.rejects(service.read(["GPIOA.MODER"]), /Debug target changed/);

    const view = render(getModernWebviewContent({}, "en"));
    try {
        view.assertHealthy();
        const section = view.document.getElementById("peripheralSection");
        assert(section);
        assert.strictEqual(
            view.document.getElementById("svdSelect").closest("#otherConfig"),
            view.document.getElementById("otherConfig")
        );
        assert.strictEqual(view.document.querySelector("#peripheralSection #svdSelect"), null);
        assert(!view.messages.some((message) => message.type === "peripheralCatalogRequest"));
        view.send({ type: "svdStatus", state: "configured", path: "/device.svd" });
        assert(view.messages.some((message) => message.type === "peripheralCatalogRequest"));
        view.send({ type: "peripheralCatalog", ...catalog });
        view.send({ type: "peripheralDebugStatus", state: "paused", epoch: 1, canRead: true, canWrite: true });
        view.document.querySelector(".peripheral-group .peripheral-name").click();
        assert(!view.document.querySelector(".peripheral-group").textContent.includes("0x40020000"));
        assert.strictEqual(view.messages.at(-1).type, "peripheralRegistersRequest");
        view.send({ type: "peripheralRegisters", name: "GPIOA", registers: [register] });
        assert(view.messages.some((message) => message.type === "peripheralReadRequest"));
        view.send({ type: "peripheralReadResult", registers: result.registers.slice(0, 1) });
        assert.strictEqual(
            view.document.querySelector(".peripheral-register .peripheral-editor-input").value,
            "0x00000002"
        );
        assert.strictEqual(view.document.querySelector(".peripheral-register .peripheral-edit"), null);
        assert.strictEqual(view.document.querySelector(".peripheral-register .peripheral-apply"), null);
        assert.strictEqual(view.document.querySelector(".peripheral-register .peripheral-cancel"), null);
        view.document.querySelector(".peripheral-register .peripheral-disclosure").click();
        assert(view.document.getElementById("peripheralTree").textContent.includes("MODE0 [1:0]"));
        view.document.getElementById("peripheralFormat").click();
        assert(view.document.getElementById("peripheralTree").textContent.includes("Alternate"));
        assert.strictEqual(view.document.querySelector(".peripheral-field .peripheral-editor-input").value, "2");
        view.document.querySelector(".peripheral-field .peripheral-step[title*='Increase']").click();
        assert.deepStrictEqual(view.messages.at(-1), {
            type: "peripheralWriteRequest",
            target: "GPIOA.MODER.MODE0",
            value: "3"
        });
        assert.strictEqual(view.document.querySelector(".peripheral-field .peripheral-editor-input").disabled, true);
        view.send({
            type: "peripheralWriteResult",
            target: "GPIOA.MODER.MODE0",
            result: { results: [{ register: "GPIOA.MODER" }] }
        });
        assert.deepStrictEqual(view.messages.at(-1), { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        view.send({
            type: "peripheralReadResult",
            registers: [
                { path: "GPIOA.MODER", value: "0x00000003", fields: [{ path: "GPIOA.MODER.MODE0", value: "0x3" }] }
            ]
        });
        assert.strictEqual(view.document.querySelector(".peripheral-field .peripheral-editor-input").value, "3");
        assert.strictEqual(
            view.document.querySelector(".peripheral-field .peripheral-step[title*='Increase']").disabled,
            true
        );
        let input = view.document.querySelector(".peripheral-field .peripheral-editor-input");
        input.value = "4";
        input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
        assert.strictEqual(input.getAttribute("aria-invalid"), "true");
        const beforeInvalid = view.messages.length;
        input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        assert.strictEqual(view.messages.length, beforeInvalid, "out-of-range field value must not reach the host");
        assert(view.document.getElementById("peripheralStatus").textContent.includes("2-bit"));
        input.value = "bad";
        input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new view.window.Event("blur"));
        assert.strictEqual(view.messages.length, beforeInvalid, "malformed field value must not reach the host");
        input.value = "0x0";
        input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        assert.deepStrictEqual(view.messages.at(-1), {
            type: "peripheralWriteRequest",
            target: "GPIOA.MODER.MODE0",
            value: "0x0"
        });
        view.send({
            type: "peripheralError",
            operation: "peripheralWriteRequest",
            target: "GPIOA.MODER.MODE0",
            message: "Write failed"
        });
        assert.strictEqual(view.document.querySelector(".peripheral-field .peripheral-editor-input").disabled, false);
        input = view.document.querySelector(".peripheral-register .peripheral-editor-input");
        input.value = "0x00000001";
        input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new view.window.Event("blur"));
        assert.deepStrictEqual(view.messages.at(-1), {
            type: "peripheralWriteRequest",
            target: "GPIOA.MODER",
            value: "0x00000001"
        });
        view.send({
            type: "peripheralWriteResult",
            target: "GPIOA.MODER",
            result: { results: [{ register: "GPIOA.MODER" }] }
        });
        input = view.document.querySelector(".peripheral-register .peripheral-editor-input");
        input.value = "0x00000002";
        input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
        view.send({
            type: "peripheralReadResult",
            registers: [
                { path: "GPIOA.MODER", value: "0x00000001", fields: [{ path: "GPIOA.MODER.MODE0", value: "0x1" }] }
            ]
        });
        assert.strictEqual(
            view.document.querySelector(".peripheral-register .peripheral-editor-input").value,
            "0x00000002",
            "a new draft must survive the previous write's read-back refresh"
        );
        view.send({ type: "peripheralDebugStatus", state: "running", epoch: 2, canRead: false, canWrite: false });
        assert.strictEqual(view.document.getElementById("peripheralRefresh").disabled, true);
        assert.strictEqual(view.document.querySelector(".peripheral-register .peripheral-editor-input").disabled, true);
        assert.strictEqual(view.document.querySelector(".peripheral-register .peripheral-step").disabled, true);
        view.send({ type: "svdStatus", state: "idle" });
        assert.strictEqual(view.document.getElementById("peripheralTree").textContent, "");
        assert.strictEqual(view.document.getElementById("peripheralFilter").disabled, true);
        view.send({ type: "svdStatus", state: "configured", path: "/replacement.svd" });
        view.send({ type: "peripheralCatalog", ...catalog });
        assert.strictEqual(view.document.getElementById("peripheralTree").textContent, "");
        view.send({ type: "peripheralCatalog", ...catalog, svd: { ...catalog.svd, path: "/replacement.svd" } });
        assert(view.document.getElementById("peripheralTree").textContent.includes("GPIOA"));
        view.assertHealthy();
    } finally {
        view.close();
    }

    const Provider = loadProvider({
        window: {
            showInputBox: () => {
                throw new Error("UI write must not open a VS Code input box");
            },
            showWarningMessage: () => {
                throw new Error("UI write must not open a confirmation dialog");
            }
        }
    });
    const provider = Object.create(Provider.prototype);
    provider._svdManager = { currentPath: async () => "/device.svd" };
    provider._debugBridge = {};
    provider._assertWriteSessionCurrent = () => {};
    provider._svdPeripheralService = {
        write: () => {
            throw new Error("UI write must not use the Agent Skill authorization path");
        },
        writeFromUi: async (params) => {
            assert.deepStrictEqual(params, { writes: [{ target: "GPIOA.MODER.MODE0", value: "0x1" }] });
            return { results: [{ register: "GPIOA.MODER", verified: true }] };
        }
    };
    provider._t = (key) => key;
    const posted = [];
    const webview = { postMessage: (message) => posted.push(message) };
    await provider._handlePeripheralViewRequest(webview, {
        type: "peripheralWriteRequest",
        target: "GPIOA.MODER.MODE0",
        value: " 0x1 "
    });
    assert.strictEqual(posted[0].type, "peripheralWriteResult");
    assert.strictEqual(posted[0].result.results[0].verified, true);
    await provider._handlePeripheralViewRequest(webview, {
        type: "peripheralWriteRequest",
        target: "GPIOA.MODER.MODE0",
        value: ""
    });
    assert.strictEqual(posted[1].type, "peripheralError");

    console.log("Native peripheral tree, DAP read guards and value controls passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
