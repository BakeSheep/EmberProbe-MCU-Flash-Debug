"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { PeripheralViewService } = require("../src/services/peripheralViewService");
const { getModernWebviewContent } = require("../src/modernView");
const { render } = require("./helpers/render-webview");
const { FakeClock } = require("./helpers/fake-clock");
const { createSidebarHandler } = require("../src/controllers/sidebarRoutes");

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
    peripherals.readForView = async (targets) => ({
        registers: await Promise.all(
            targets.map(async (target) => {
                try {
                    return (await peripherals.read({ targets: [target] })).registers[0];
                } catch (error) {
                    return { path: target, code: error.code, error: error.message };
                }
            })
        )
    });
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
    peripherals.readForView = async () => {
        epoch++;
        throw new Error("Debug target changed");
    };
    await assert.rejects(service.read(["GPIOA.MODER"]), /Debug target changed/);

    const view = render(getModernWebviewContent({}, "en"));
    try {
        view.assertHealthy();
        const section = view.document.getElementById("peripheralSection");
        assert(section);
        section.open = true;
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
        section.open = false;
        const readCount = view.messages.filter((message) => message.type === "peripheralReadRequest").length;
        view.send({ type: "peripheralDebugStatus", state: "paused", epoch: 3, canRead: true, canWrite: true });
        await new Promise((resolve) => setTimeout(resolve, 180));
        assert.strictEqual(
            view.messages.filter((message) => message.type === "peripheralReadRequest").length,
            readCount,
            "cached expanded groups do not trigger hardware reads in a collapsed section"
        );
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

    const host = {
        _svdManager: { currentPath: async () => "/device.svd" },
        _debugBridge: {},
        _writes: { assertSessionCurrent: () => {} },
        _svdPeripheralService: {
            write: () => {
                throw new Error("UI write must not use the Agent Skill authorization path");
            },
            writeFromUi: async (params) => {
                assert.deepStrictEqual(params, { writes: [{ target: "GPIOA.MODER.MODE0", value: "0x1" }] });
                return { results: [{ register: "GPIOA.MODER", verified: true }] };
            }
        },
        _t: (key) => key
    };
    const posted = [];
    const handleMessage = createSidebarHandler(
        host,
        { webview: { postMessage: (message) => posted.push(message) } },
        {
            window: {
                showInputBox: () => {
                    throw new Error("UI write must not open a VS Code input box");
                },
                showWarningMessage: () => {
                    throw new Error("UI write must not open a confirmation dialog");
                }
            }
        }
    );
    await handleMessage({ type: "peripheralWriteRequest", target: "GPIOA.MODER.MODE0", value: " 0x1 " });
    assert.strictEqual(posted[0].type, "peripheralWriteResult");
    assert.strictEqual(posted[0].result.results[0].verified, true);
    await handleMessage({ type: "peripheralWriteRequest", target: "GPIOA.MODER.MODE0", value: "" });
    assert.strictEqual(posted[1].type, "peripheralError");
    assert.strictEqual(posted[1].writeAcknowledged, false);
    host._svdPeripheralService.writeFromUi = async () => {
        throw Object.assign(new Error("Peripheral access target or state changed"), {
            code: "DEBUG_STATE_CHANGED",
            details: { writeAcknowledged: true, resultUnknown: false }
        });
    };
    await handleMessage({ type: "peripheralWriteRequest", target: "GPIOA.MODER.MODE0", value: "0x1" });
    assert.strictEqual(posted[2].type, "peripheralError");
    assert.strictEqual(posted[2].writeAcknowledged, true, "the view learns the write already completed");
    assert.strictEqual(posted[2].resultUnknown, false);

    await scenario("Batch peripheral reads without reloading or hiding per-target failures", async () => {
        const { SvdPeripheralService } = require("../src/services/svdPeripheralService");
        const { PeripheralWriteAuthorization } = require("../src/peripheralWriteAuthorization");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const field = (content = "", name = "F", offset = 0) =>
            `<field><name>${name}</name><bitOffset>${offset}</bitOffset><bitWidth>8</bitWidth>${content}</field>`;
        function fixture(xml, options = {}) {
            let epoch = 1,
                reads = 0,
                loads = 0;
            const writes = [];
            const memory = new Map();
            const bridge = {
                activeSession: { id: "test" },
                assertPausedAccess() {},
                agentStatus: () => ({ epoch, session: { id: "test" } }),
                readPausedMemory: async (address, bytes) => {
                    reads++;
                    return memory.get(address) || Buffer.alloc(bytes);
                },
                writePausedMemory: async (address, bytes) => {
                    writes.push(address);
                    memory.set(address, bytes);
                }
            };
            const service = new SvdPeripheralService({
                loadBoundSvd: async () => {
                    loads++;
                    return { path: "test.svd", buffer: Buffer.from(xml) };
                },
                debugBridge: bridge,
                authorization: new PeripheralWriteAuthorization(),
                ...options
            });
            return { service, bridge, writes, memory, counts: () => ({ loads, reads }), resume: () => epoch++ };
        }
        // View batching preserves per-target failures but does not reload the model.
        const f = fixture(
            device(
                peripheral(
                    "P",
                    register(`<fields>${field()}</fields>`) + register("<readAction>clear</readAction>", "S", 4)
                )
            )
        );
        try {
            const view = new PeripheralViewService({ peripherals: f.service, debugBridge: f.bridge });
            const result = await view.read(["P.R", "P.R.F", "P.S", "missing"]);
            assert.deepStrictEqual(f.counts(), { loads: 1, reads: 1 });
            assert.strictEqual(result.registers[0], result.registers[1]);
            assert.strictEqual(result.registers[2].code, "PERIPHERAL_READ_SIDE_EFFECT");
            assert.strictEqual(result.registers[3].code, "SVD_TARGET_NOT_FOUND");
            f.bridge.readPausedMemory = async () => {
                f.resume();
                return Buffer.alloc(4);
            };
            await assert.rejects(view.read(["P.R"]), { code: "DEBUG_STATE_CHANGED" });
        } finally {
            f.service.dispose();
        }
    });

    for (const [state, mode] of [
        ["none", "standalone"],
        ["running", "debug-running"],
        ["paused", "debug-paused"]
    ]) {
        const liveView = render(getModernWebviewContent({}, "en"));
        try {
            liveView.document.getElementById("peripheralSection").open = true;
            liveView.send({
                type: "peripheralDebugStatus",
                state,
                mode,
                generation: 7,
                epoch: 1,
                canRead: true,
                canWrite: true
            });
            liveView.send({ type: "svdStatus", state: "configured", path: "/device.svd" });
            liveView.send({
                type: "peripheralCatalog",
                ...catalog,
                requestGeneration: 7,
                requestSvdPath: "/device.svd"
            });
            liveView.document.querySelector(".peripheral-group .peripheral-name").click();
            liveView.send({
                type: "peripheralRegisters",
                name: "GPIOA",
                registers: [register],
                requestGeneration: 7,
                requestSvdPath: "/device.svd"
            });
            const request = liveView.messages.findLast((item) => item.type === "peripheralReadRequest");
            assert.strictEqual(request.accessGeneration, 7);
            assert.strictEqual(request.svdPath, "/device.svd");
            const result = {
                type: "peripheralReadResult",
                requestGeneration: 7,
                requestSvdPath: "/device.svd",
                registers: [{ path: "GPIOA.MODER", value: "0x00000002" }]
            };
            liveView.send(result);
            const selector = ".peripheral-register .peripheral-editor-input";
            assert.strictEqual(liveView.document.querySelector(selector).disabled, false);
            liveView.send({
                ...result,
                requestGeneration: 6,
                registers: [{ path: "GPIOA.MODER", value: "0x000000ff" }]
            });
            assert.strictEqual(liveView.document.querySelector(selector).value, "0x00000002");
            const input = liveView.document.querySelector(selector);
            input.value = "3";
            input.dispatchEvent(new liveView.window.Event("input", { bubbles: true }));
            liveView.send(result);
            assert.strictEqual(liveView.document.querySelector(selector).value, "3", "refresh preserves edits");
            liveView.send({
                type: "peripheralWriteResult",
                target: "GPIOA.MODER",
                requestGeneration: 7,
                result: { results: [{ register: "GPIOA.MODER", verified: false, verification: "different" }] }
            });
            assert(liveView.document.getElementById("peripheralStatus").textContent.includes("readback differs"));
            liveView.send({
                type: "peripheralDebugStatus",
                state,
                mode,
                generation: 8,
                epoch: 1,
                canRead: true,
                canWrite: true
            });
            liveView.send(result);
            assert.strictEqual(liveView.document.querySelector(selector).value, "", "old generation is discarded");
            liveView.assertHealthy();
        } finally {
            liveView.close();
        }
    }
    await scenario("Enable peripheral controls only with sampling or a supported debug connection", async () => {
        const clock = new FakeClock();
        const restored = render(getModernWebviewContent({}, "en"), { peripheralExpanded: ["GPIOA"] }, { clock });
        try {
            restored.document.getElementById("peripheralSection").open = true;
            const status = (state, mode, generation, enabled = true) =>
                restored.send({
                    type: "peripheralDebugStatus",
                    state,
                    mode,
                    generation,
                    epoch: 1,
                    canRead: enabled,
                    canWrite: enabled,
                    reason: enabled ? "" : "PERIPHERAL_SAMPLING_REQUIRED"
                });
            const reads = () => restored.messages.filter((item) => item.type === "peripheralReadRequest").length;
            const notice = () => restored.document.getElementById("peripheralStatus").textContent;
            status("none", "standalone", 1, false);
            restored.send({ type: "svdStatus", state: "configured", path: "/device.svd" });
            restored.send({
                type: "peripheralCatalog",
                ...catalog,
                requestGeneration: 1,
                requestSvdPath: "/device.svd"
            });
            restored.send({
                type: "peripheralRegisters",
                name: "GPIOA",
                registers: [register, { ...register, name: "ODD", path: "GPIOA.ODD", size: 24, fields: [] }],
                requestGeneration: 1,
                requestSvdPath: "/device.svd"
            });
            await clock.advance(1000);
            assert.strictEqual(reads(), 0, "an idle view never connects the probe");
            assert(notice().includes("Start sampling or debugging"), notice());
            const refresh = restored.document.getElementById("peripheralRefresh");
            assert.strictEqual(refresh.disabled, true);
            assert(
                [...restored.document.querySelectorAll(".peripheral-editor-input")].every((input) => input.disabled)
            );
            refresh.click();
            restored.document.querySelector(".peripheral-register .peripheral-name").click();
            assert.strictEqual(reads(), 0, "clicks cannot bypass the sampling gate");

            status("none", "standalone", 2);
            await clock.advance(1000);
            assert.strictEqual(reads(), 1, "starting sampling refreshes expanded registers through its connection");
            assert(notice().includes("Sampling active"), notice());
            assert(!notice().includes("connects the probe"));
            restored.document.getElementById("peripheralRefresh").click();
            assert.strictEqual(reads(), 2, "an explicit refresh reuses sampling");
            status("none", "standalone", 3, false);
            await clock.advance(1000);
            assert.strictEqual(reads(), 2, "stopping sampling cancels automatic reads");
            assert.strictEqual(restored.document.getElementById("peripheralRefresh").disabled, true);
            status("running", "debug-running", 3);
            await clock.advance(1000);
            assert.strictEqual(reads(), 3, "debug access still refreshes expanded registers without sampling");
            const running = restored.messages.findLast((item) => item.type === "peripheralReadRequest");
            assert.deepStrictEqual(running.targets, ["GPIOA.MODER"], "running access skips non-natural widths");
            const inputs = restored.document.querySelectorAll(".peripheral-register .peripheral-editor-input");
            assert.deepStrictEqual(
                [...inputs].map((input) => input.disabled),
                [false, true]
            );

            status("running", "debug-running", 4);
            await clock.advance(1000);
            const before = reads();
            const writeError = {
                type: "peripheralError",
                operation: "peripheralWriteRequest",
                target: "GPIOA.MODER",
                requestGeneration: 3,
                requestSvdPath: "/device.svd",
                message: "Peripheral access target or state changed"
            };
            restored.send({ ...writeError, writeAcknowledged: true, resultUnknown: false });
            assert(notice().includes("Write command completed, then failed"), notice());
            restored.send({ ...writeError, writeAcknowledged: false, resultUnknown: true });
            assert(notice().includes("Write result unknown"), notice());
            restored.send({
                type: "peripheralWriteResult",
                target: "GPIOA.MODER",
                requestGeneration: 3,
                requestSvdPath: "/device.svd",
                result: { results: [{ register: "GPIOA.MODER", verified: false, verification: "unavailable" }] }
            });
            assert(notice().includes("readback is unavailable"), notice());
            assert.strictEqual(reads(), before, "a stale write result does not read with the new generation");
            restored.assertHealthy();
        } finally {
            restored.close();
        }
    });
    await scenario("Refresh open peripheral registers at 20 Hz on the sampling connection", async () => {
        const clock = new FakeClock();
        const view = render(
            getModernWebviewContent({}, "en"),
            { peripheralExpanded: ["GPIOA", "GPIOA.MODER"] },
            { clock }
        );
        const { document } = view;
        const section = document.getElementById("peripheralSection");
        let hidden = false;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        try {
            section.open = true;
            const status = (mode = "standalone", canRead = true, generation = 1) =>
                view.send({
                    type: "peripheralDebugStatus",
                    state: "none",
                    mode,
                    generation,
                    epoch: 1,
                    canRead,
                    canWrite: canRead
                });
            const polls = () => view.messages.filter((item) => item.type === "peripheralReadRequest" && item.poll);
            const reply = (value, enumName) =>
                view.send({
                    type: "peripheralReadResult",
                    requestPoll: true,
                    requestGeneration: 1,
                    requestSvdPath: "/device.svd",
                    registers: [
                        {
                            path: "GPIOA.MODER",
                            value: "0x1",
                            fields: [{ path: "GPIOA.MODER.MODE0", value: "0x1", enum: enumName }]
                        },
                        { path: "GPIOA.IDR", value, fields: [] }
                    ]
                });
            const fail = (code, message = "read failed") =>
                view.send({
                    type: "peripheralError",
                    operation: "peripheralReadRequest",
                    requestPoll: true,
                    requestGeneration: 1,
                    requestSvdPath: "/device.svd",
                    code,
                    message
                });
            // Answers every round a few milliseconds later, as a fast probe would.
            const run = async (ms) => {
                let answered = polls().length;
                for (let elapsed = 0; elapsed < ms; elapsed += 5) {
                    await clock.advance(5);
                    while (answered < polls().length) {
                        answered++;
                        reply("0x10");
                    }
                }
            };
            status("standalone", false);
            view.send({ type: "svdStatus", state: "configured", path: "/device.svd" });
            view.send({ type: "peripheralCatalog", ...catalog, requestGeneration: 1, requestSvdPath: "/device.svd" });
            view.send({
                type: "peripheralRegisters",
                name: "GPIOA",
                registers: [register, { ...register, name: "IDR", path: "GPIOA.IDR", access: "read-only", fields: [] }],
                requestGeneration: 1,
                requestSvdPath: "/device.svd"
            });
            await clock.advance(1000);
            assert.strictEqual(polls().length, 0, "no connection, no polling");

            status();
            await clock.advance(200);
            assert.strictEqual(polls().length, 1, "sampling starts the first round");
            await clock.advance(1000);
            assert.strictEqual(polls().length, 1, "an unanswered round holds the next one");
            reply("0x10");
            await clock.advance(50);
            assert.strictEqual(polls().length, 2, "a slow round is followed at once");
            reply("0x10");

            const before = polls().length;
            const value = document.querySelector(".peripheral-register .peripheral-value");
            const row = document.querySelector(".peripheral-register");
            await run(1000);
            const rounds = polls().length - before;
            assert(rounds >= 19 && rounds <= 21, `${rounds} rounds in one second`);
            assert.strictEqual(document.querySelector(".peripheral-register"), row, "polling keeps the rows");

            await clock.advance(60);
            reply("0x20");
            assert.strictEqual(document.querySelector(".peripheral-register .peripheral-value"), value);
            assert.strictEqual(value.textContent, "0x00000020", "a poll updates the shown value");
            assert(value.classList.contains("changed"));
            await clock.advance(60);
            reply("0x20");
            assert(value.classList.contains("changed"), "the mark outlasts one round");
            await clock.advance(1000);
            reply("0x20");
            assert(!value.classList.contains("changed"), "the mark fades");

            const selector = '.peripheral-editor-input[data-target="GPIOA.MODER.MODE0"]';
            const input = document.querySelector(selector);
            input.focus();
            input.value = "2";
            input.dispatchEvent(new view.window.Event("input", { bubbles: true }));
            await clock.advance(60);
            reply("0x30", "OUTPUT");
            assert.strictEqual(document.activeElement.dataset.target, "GPIOA.MODER.MODE0", "an edit keeps focus");
            assert.strictEqual(document.querySelector(selector).value, "2", "a poll leaves an edit alone");
            assert(document.querySelector(".peripheral-enum").textContent.includes("OUTPUT"), "a new enum is shown");

            await clock.advance(1000);
            const held = polls().length;
            fail("PERIPHERAL_ACCESS_BUSY");
            assert.strictEqual(document.getElementById("peripheralError")?.hidden ?? true, true);
            assert(!document.getElementById("peripheralStatus").textContent.includes("read failed"));
            await clock.advance(900);
            assert.strictEqual(polls().length, held, "a failed round backs off");
            await clock.advance(100);
            assert.strictEqual(polls().length, held + 1, "and then retries");
            fail("PERIPHERAL_READ_FAILED");
            assert(document.getElementById("peripheralStatus").textContent.includes("read failed"), "real errors show");
            await clock.advance(1000);
            reply("0x30");
            assert(!document.getElementById("peripheralStatus").textContent.includes("read failed"), "and clear");

            await clock.advance(60);
            reply("0x30");
            const quiet = async (label, restore) => {
                await clock.advance(60);
                reply("0x30");
                await clock.advance(1000);
                const count = polls().length;
                await clock.advance(1000);
                assert.strictEqual(polls().length, count, label);
                restore();
                await clock.advance(300);
                assert(polls().length > count, `${label}: resumes`);
            };
            section.open = false;
            section.dispatchEvent(new view.window.Event("toggle"));
            await quiet("a closed section is not polled", () => {
                section.open = true;
                section.dispatchEvent(new view.window.Event("toggle"));
            });
            hidden = true;
            await quiet("a hidden view is not polled", () => {
                hidden = false;
                document.dispatchEvent(new view.window.Event("visibilitychange"));
            });
            status("debug-paused");
            await quiet("a paused target is not polled", () => status());
            view.assertHealthy();
        } finally {
            view.close();
        }

        const replies = [];
        let statusPosts = 0;
        const route = createSidebarHandler(
            {
                _svdManager: { currentPath: async () => "/device.svd" },
                _peripheralAccessService: { status: () => ({ generation: 1 }) },
                _peripheralViewService: { read: async () => ({ registers: [] }) },
                _postPeripheralDebugStatus: () => statusPosts++,
                _t: (key) => key
            },
            { webview: { postMessage: (message) => replies.push(message) } },
            { window: {} }
        );
        const read = { type: "peripheralReadRequest", targets: ["GPIOA.MODER"], accessGeneration: 1 };
        await route({ ...read, poll: true });
        assert.strictEqual(replies.at(-1).requestPoll, true, "a poll reply is marked");
        assert.strictEqual(statusPosts, 0, "a poll posts no status");
        await route(read);
        assert.strictEqual(replies.at(-1).requestPoll, undefined);
        assert.strictEqual(statusPosts, 1, "other reads still post the status");
    });
    console.log("Native peripheral tree, DAP read guards and value controls passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
