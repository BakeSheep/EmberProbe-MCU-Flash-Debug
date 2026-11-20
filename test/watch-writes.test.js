"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

const types = [
    { kind: "scalar", typeName: "float", byteSize: 4, watchType: "f32" },
    { kind: "scalar", typeName: "bool", byteSize: 1, watchType: "u8", isBoolean: true },
    { kind: "alias", target: 0, isConst: true },
    {
        kind: "class",
        typeName: "Motor",
        byteSize: 16,
        fields: [
            { name: "gain", offset: 0, type: 0 },
            { name: "enabled", offset: 4, type: 1 },
            { name: "limit", offset: 8, type: 2 },
            { name: "next", offset: 12, type: 4 }
        ]
    },
    { kind: "pointer", target: 3, byteSize: 4, pointerTarget: "data" }
];
const graph = { root: 4, types };

(async () => {
    await scenario("Add fixed-address ELF scalars and members while sampling is stopped", async () => {
        const view = render(getModernWebviewContent({}, "en"), { sbExpanded: { bundle: true } });
        try {
            const scalar = {
                name: "counter",
                address: 0x20000000,
                watchType: "u32",
                size: 4,
                hasDwarfWriteType: true
            };
            const bundle = {
                name: "bundle",
                address: 0x20000010,
                size: 16,
                isComposite: true,
                compositeLayout: {
                    kind: "class",
                    members: [
                        { name: "signature", offset: 4, byteSize: 4, watchType: "f32" },
                        { name: "limit", offset: 8, byteSize: 4, watchType: "f32", isConst: true }
                    ]
                },
                runtimeLayout: {
                    root: types.length,
                    types: [
                        ...types,
                        {
                            kind: "class",
                            typeName: "Bundle",
                            byteSize: 16,
                            fields: [
                                { name: "signature", offset: 4, type: 0 },
                                { name: "limit", offset: 8, type: 2 },
                                { name: "next", offset: 12, type: 4 }
                            ]
                        }
                    ]
                }
            };
            view.send({
                type: "availableVariables",
                symbols: [scalar, bundle],
                writeRanges: [{ start: 0x20000000, end: 0x20000020 }]
            });
            view.send({ type: "sidebarWatchList", items: [{ ...scalar, type: "u32" }, bundle] });
            await Promise.resolve();
            const open = (name) => {
                const row = view.document.querySelector(`[data-breakpoint-path="${name}"]`);
                assert(row, name);
                row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true }));
                return view.document.querySelector(".watch-write-action");
            };
            const writeList = () => view.messages.findLast((message) => message.type === "saveSidebarWrite").items;
            assert.strictEqual(open("bundle.limit").disabled, true);
            assert.strictEqual(open("counter").disabled, false);
            open("counter").click();
            assert.strictEqual(open("bundle.signature").disabled, false);
            open("bundle.signature").click();
            assert.deepStrictEqual(
                writeList().map(({ name, address, fromWatch }) => [name, address, fromWatch]),
                [
                    ["counter", 0x20000000, undefined],
                    ["bundle.signature", 0x20000014, undefined]
                ]
            );
            assert([...view.document.querySelectorAll(".write-input")].every((input) => input.disabled));
            assert(!view.messages.some((message) => message.type === "writeVariable"));
            open("bundle.signature").click();
            assert.deepStrictEqual(
                writeList().map(({ name }) => name),
                ["counter"]
            );
            view.assertHealthy();
        } finally {
            view.close();
        }
    });
    await scenario(
        "Add watched dynamic leaves without writing, gate stale values and recover from new samples",
        async () => {
            const clock = new FakeClock();
            const view = render(getModernWebviewContent({}, "zh"), {}, { clock });
            try {
                const symbol = {
                    name: "motor",
                    address: 0x20000000,
                    size: 4,
                    type: "u32",
                    isPointer: true,
                    runtimeLayout: graph
                };
                const pointee = {
                    ...symbol,
                    name: "motor.value",
                    isPointer: false,
                    isComposite: true,
                    runtimeSegments: [{ kind: "member", name: "value" }],
                    compositeLayout: { kind: "class", members: [], runtimeLayout: graph }
                };
                view.send({ type: "availableVariables", symbols: [symbol] });
                view.send({ type: "sidebarWatchList", items: [symbol, pointee] });
                let writeContext = 1;
                const status = () => ({
                    type: "liveStatus",
                    running: true,
                    canRead: true,
                    canWrite: true,
                    source: "openocd",
                    writeContext
                });
                const tree = (gain, address = 0x20000400) => ({
                    kind: "class",
                    typeName: "Motor",
                    members: [
                        {
                            name: "gain",
                            writeRestriction: "",
                            kind: "scalar",
                            type: "f32",
                            typeName: "float",
                            address,
                            value: gain,
                            valueText: String(gain)
                        },
                        {
                            name: "enabled",
                            writeRestriction: "",
                            isBoolean: true,
                            kind: "scalar",
                            type: "u8",
                            typeName: "bool",
                            address: address + 4,
                            value: 1
                        },
                        {
                            name: "limit",
                            writeRestriction: "readOnly",
                            kind: "scalar",
                            type: "f32",
                            typeName: "float",
                            address: address + 8,
                            value: 20
                        },
                        {
                            name: "next",
                            kind: "scalar",
                            isPointer: true,
                            type: "u32",
                            address: address + 12,
                            value: address
                        }
                    ]
                });
                const sample = (gain, address) =>
                    view.send({
                        type: "liveCompositeSample",
                        samples: [{ name: "motor.value", tree: tree(gain, address), writeContext }]
                    });
                const open = async (name = "motor.value.gain") => {
                    await Promise.resolve();
                    const row = view.document.querySelector('[data-breakpoint-path="' + name + '"]');
                    assert(row, name);
                    row.dispatchEvent(
                        new view.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })
                    );
                    return view.document.querySelector(".watch-write-action");
                };
                view.send(status());
                assert((await open()).disabled, "placeholder values never enable addition");
                sample(2.5);
                await clock.advance(100);
                const add = await open();
                assert.strictEqual(add.disabled, false);
                const before = view.messages.filter((message) => message.type === "writeVariable").length;
                add.click();
                assert.strictEqual(view.messages.filter((message) => message.type === "writeVariable").length, before);
                let saved = view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
                assert.strictEqual(saved.fromWatch, true);
                assert.strictEqual(saved.name, "motor.value.gain");
                assert.strictEqual(saved.value, 2.5);
                assert.deepStrictEqual(saved.writeBinding, {
                    address: 0x20000400,
                    type: "f32",
                    size: 4,
                    isBoolean: false,
                    typeName: "float"
                });
                const input = view.document.querySelector(".write-input");
                input.value = "3";
                input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
                const request = view.messages.findLast((message) => message.type === "writeVariable");
                assert.strictEqual(request.name, "motor.value.gain");
                assert.strictEqual(request.address, undefined);
                assert.deepStrictEqual(request.binding, saved.writeBinding);
                assert.strictEqual(request.writeContext, 1);
                view.send({
                    ...request,
                    type: "writeResult",
                    ok: false,
                    diagnostic: {
                        code: "WRITE_TARGET_CHANGED",
                        details: { written: false, writtenItems: 0 }
                    }
                });
                assert(input.disabled);
                assert(view.document.getElementById("noticeWrite").textContent.includes("本次未写入"));
                sample(4, 0x20000500);
                await clock.advance(1100);
                assert(input.disabled);
                assert.strictEqual(input.value, "2.5");
                saved = view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
                view.send({ ...status(), running: false, canRead: false, canWrite: false });
                assert(input.disabled);
                writeContext++;
                view.send(status());
                assert(input.disabled, "restart waits for a sample from the current connection");
                sample(5);
                await clock.advance(100);
                assert.strictEqual(input.disabled, false);
                assert.strictEqual(input.value, "5");
                for (const [name, hint] of [
                    ["limit", "只读"],
                    ["next", "指针本身"]
                ]) {
                    const action = await open("motor.value." + name);
                    assert(action.disabled);
                    assert(action.title.includes(hint));
                }
                view.send({ type: "sidebarWatchList", items: [] });
                assert(input.disabled);
                assert(input.title.includes("重新加入查看列表"));
                view.send({ type: "sidebarWriteList", items: [saved] });
                assert(
                    view.document.querySelector(".write-input").disabled,
                    "restored watch-bound cards keep their gate"
                );
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
    );
    await scenario("Restore pinned boolean cards and leave risk indicators tied to the original address", async () => {
        const clock = new FakeClock();
        const view = render(getModernWebviewContent({}, "en"), { sbExpanded: { "motor.value": true } }, { clock });
        try {
            const symbol = { name: "motor", address: 0x20000000, size: 4, runtimeLayout: graph };
            const watch = {
                ...symbol,
                name: "motor.value",
                isComposite: true,
                compositeLayout: { kind: "class", members: [], runtimeLayout: graph }
            };
            view.send({ type: "availableVariables", symbols: [symbol] });
            view.send({ type: "sidebarWatchList", items: [watch] });
            view.send({
                type: "sidebarWriteList",
                items: [
                    {
                        name: "motor.value.enabled",
                        type: "u8",
                        min: 0,
                        max: 1,
                        value: 1,
                        fromWatch: true,
                        writeBinding: { address: 0x20000404, type: "u8", size: 1, isBoolean: true, typeName: "bool" }
                    },
                    {
                        name: "motor.value.gain",
                        type: "f32",
                        address: 0x20000400,
                        min: 0,
                        max: 10,
                        value: 2,
                        fromWatch: true,
                        writeBinding: { address: 0x20000400, type: "f32", size: 4, isBoolean: false, typeName: "float" }
                    }
                ]
            });
            view.send({
                type: "liveStatus",
                running: true,
                canRead: true,
                canWrite: true,
                source: "openocd",
                writeContext: 1
            });
            const sample = (address) =>
                view.send({
                    type: "liveCompositeSample",
                    samples: [
                        {
                            name: "motor.value",
                            writeContext: 1,
                            tree: {
                                kind: "class",
                                typeName: "Motor",
                                members: [
                                    {
                                        name: "enabled",
                                        writeRestriction: "",
                                        isBoolean: true,
                                        kind: "scalar",
                                        type: "u8",
                                        typeName: "bool",
                                        value: 1,
                                        address: 0x20000404
                                    },
                                    {
                                        name: "gain",
                                        kind: "scalar",
                                        type: "f32",
                                        typeName: "float",
                                        value: 2,
                                        address,
                                        writeRestriction: ""
                                    }
                                ]
                            }
                        }
                    ]
                });
            sample(0x20000400);
            await clock.advance(100);
            const rows = view.document.querySelectorAll(".write-row");
            assert.strictEqual(rows[0].querySelector(".value-type").textContent, "bool");
            const input = rows[0].querySelector(".write-input");
            assert.strictEqual(input.disabled, false, input.title);
            input.value = "2";
            input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
            assert.strictEqual(view.messages.filter((message) => message.type === "writeVariable").length, 0);
            assert.strictEqual(input.value, "1");
            assert.strictEqual(rows[1].querySelector(".write-risk"), null);
            const gainInput = rows[1].querySelector(".write-input");
            sample(0x20000402);
            await clock.advance(100);
            assert(gainInput.disabled);
            assert.match(gainInput.title, /once a sample confirms the original address and type/);
            assert.strictEqual(rows[1].querySelector(".write-risk"), null);
            sample(0x20000400);
            await clock.advance(100);
            assert.strictEqual(gainInput.disabled, false);
            assert.strictEqual(gainInput.title, "");
            assert.strictEqual(rows[1].querySelector(".write-risk"), null);
            view.assertHealthy();
        } finally {
            view.close();
        }
    });

    await scenario("Cancel debounced and sent scalar writes across sample and session changes", async () => {
        const clock = new FakeClock();
        const view = render(getModernWebviewContent({}, "en"), {}, { clock });
        try {
            const name = "p.value";
            const address = 0x20000400;
            const binding = { address, type: "f32", size: 4, isBoolean: false, typeName: "float" };
            const root = {
                name: "p",
                address: 0x20000000,
                size: 4,
                type: "u32",
                isPointer: true,
                runtimeLayout: { root: 1, types: [types[0], { ...types[4], target: 0 }] }
            };
            view.send({ type: "availableVariables", symbols: [root] });
            view.send({ type: "sidebarWatchList", items: [{ ...root, name, isPointer: false, type: "f32" }] });
            const stored = { name, ...binding, value: 1, min: 0, max: 10, fromWatch: true };
            view.send({ type: "sidebarWriteList", items: [stored] });
            const status = (writeContext, source = "dap") =>
                view.send({
                    type: "liveStatus",
                    running: true,
                    canRead: true,
                    canWrite: true,
                    writeContext,
                    source,
                    mode: source === "dap" ? "debug-paused-sampling" : "debug-running-sampling"
                });
            const sample = (samples) =>
                view.send({
                    type: "liveSample",
                    samples: samples.map((next) => ({
                        name,
                        ...binding,
                        writeContext: 1,
                        writeRestriction: "",
                        ...next
                    }))
                });
            const input = () => view.document.querySelector(".write-input");
            status(1);
            sample([{ value: 2 }]);
            assert(
                input().disabled && /Remove it, then add it again/.test(input().title),
                "old cards require a new binding"
            );
            view.send({ type: "sidebarWriteList", items: [{ ...stored, writeBinding: binding }] });
            assert.strictEqual(input().disabled, false, input().title);
            const nameLabel = view.document.querySelector(".write-row .value-name");
            sample([{ address: address + 4, value: 3 }]);
            assert.ok(nameLabel.closest(".write-row.gated"), "the variable name is in the greyed state");
            sample([{ value: 2 }]);
            assert.equal(nameLabel.closest(".write-row.gated"), null, "the original address restores the name");
            const slider = view.document.querySelector(".write-row input[type=range]");
            slider.value = "6";
            slider.dispatchEvent(new view.window.Event("input"));
            sample([{ address: address + 4, value: 7 }, { value: 3 }]);
            await clock.advance(500);
            assert.strictEqual(input().value, "3");
            slider.dispatchEvent(new view.window.Event("change"));
            assert(!view.messages.some((message) => message.type === "writeVariable"));
            sample([{ type: "u32", value: 3 }]);
            assert(input().disabled, "equal address with a different encoding cannot write");
            sample([{ typeName: "Other", value: 3 }]);
            assert(input().disabled, "same encoding with a different DWARF type cannot write");
            sample([{ value: 3, stale: true }]);
            assert(input().disabled);
            sample([{ value: 4 }]);
            assert.strictEqual(input().disabled, false);
            input().value = "5";
            input().dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
            const request = view.messages.findLast((message) => message.type === "writeVariable");
            status(2, "openocd");
            assert(input().disabled);
            assert(
                view.messages.some((message) => message.type === "cancelSidebarWrite" && message.seq === request.seq)
            );
            sample([{ value: 7 }]);
            assert(input().disabled, "a late sample from the former debug stop cannot unlock the card");
            view.send({ ...request, type: "writeResult", ok: true, value: 5 });
            assert.strictEqual(input().value, "4");
            sample([{ value: 8, writeContext: 2 }]);
            assert.strictEqual(input().disabled, false);
            assert.strictEqual(input().value, "8");
            for (const [writeContext, written, verified, text] of [
                [3, false, false, /Nothing was written/],
                [4, true, false, /Wrote 1\/1 values and could not finish read-back verification/],
                [5, true, true, /passed read-back verification/]
            ]) {
                input().value = "9";
                input().dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
                const sent = view.messages.findLast((message) => message.type === "writeVariable");
                status(writeContext, "openocd");
                sample([{ value: 8, writeContext }]);
                view.send({
                    ...sent,
                    type: "writeResult",
                    ok: false,
                    diagnostic: {
                        code: "DEBUG_STATE_CHANGED",
                        details: { written, writtenItems: Number(written), totalItems: 1, verified }
                    }
                });
                assert.match(view.document.getElementById("noticeWrite").textContent, text);
                if (verified)
                    assert.match(
                        view.document.querySelector("#noticeWrite .notice-title").textContent,
                        /Write verified/
                    );
                assert.strictEqual(input().value, "8", "an old session's outcome does not overwrite the current card");
            }
            view.assertHealthy();
        } finally {
            view.close();
        }
    });

    await scenario("Require explicit DWARF encoding evidence for a root scalar menu entry", async () => {
        const { create } = require("../src/webview/sidebar/watchWrites");
        const symbol = { name: "value", type: "u32", watchType: "u32", address: 0x20000000, size: 4 };
        const state = {
            watch: [symbol],
            writeList: [],
            symbols: new Map([[symbol.name, symbol]]),
            latest: { value: 3 },
            latestText: {}
        };
        const menu = create({ state, canRead: () => true, has: () => false, toggle: () => {} });
        menu.setContext(1);
        menu.sampled([{ name: "value", value: 3, writeContext: 1 }]);
        assert.strictEqual(menu.entry("value").key, "sb.writeTypeUnknown");
        symbol.hasDwarfWriteType = true;
        assert.strictEqual(menu.entry("value").entry.type, "u32");
    });

    console.log("Watch-list write menu, dynamic qualifiers, sampling gates and stale results passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
