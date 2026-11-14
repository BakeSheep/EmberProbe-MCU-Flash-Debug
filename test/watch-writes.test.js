"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { dynamicAccess } = require("../src/webview/sidebar/watchWrites");

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
const segments = (name) => require("../src/webview/runtime").memberPathSegments(name).segments;

(async () => {
    await scenario(
        "Use DWARF qualifications to distinguish mutable leaves and semantic container elements",
        async () => {
            const access = (name) => dynamicAccess(graph, segments(name), {});
            assert.strictEqual(access("motor.value.gain").type, "f32");
            assert.strictEqual(access("motor.value.enabled").isBoolean, true);
            assert.strictEqual(access("motor.value.limit").key, "sb.writeReadOnly");
            assert.strictEqual(access("motor").key, "sb.writePointerStorage");
            assert.strictEqual(access("motor.value.next").key, "sb.writePointerStorage");
            assert.strictEqual(access("motor.value").key, "sb.writeScalarOnly");
            assert.strictEqual(access("motor.gain").key, "sb.writePointerStorage");
            const containers = (stl) => ({
                root: 3,
                types: [types[0], types[1], types[2], { kind: "class", stl, args: [0, 1] }]
            });
            assert.strictEqual(dynamicAccess(containers("vector"), segments("v[0]"), {}).type, "f32");
            assert.strictEqual(dynamicAccess(containers("map"), segments("v[0].second"), {}).type, "u8");
            assert.strictEqual(dynamicAccess(containers("map"), segments("v[0].first"), {}).key, "sb.writeReadOnly");
            assert.strictEqual(dynamicAccess(containers("set"), segments("v[0]"), {}).key, "sb.writeReadOnly");
            assert.strictEqual(dynamicAccess(containers("basic_string"), segments("v[0]"), {}).key, "sb.writeReadOnly");
            assert.strictEqual(dynamicAccess(containers("tuple"), segments("v[1]"), {}).type, "u8");
            assert.strictEqual(
                dynamicAccess(containers("variant"), segments("v.value"), { typeName: "float" }).type,
                "f32"
            );
            assert.strictEqual(
                dynamicAccess(containers("variant"), segments("v.value"), {}).key,
                "sb.writeTypeUnknown"
            );
            const union = { root: 0, types: [{ kind: "union", fields: [{ name: "value", type: 1 }] }, types[0]] };
            assert.strictEqual(dynamicAccess(union, segments("u.value"), {}).key, "sb.writeUnsupported");
            const incomplete = { root: 0, types: [{ kind: "alias", target: 0 }] };
            assert.strictEqual(dynamicAccess(incomplete, [], {}).key, "sb.writeTypeUnknown");
        }
    );

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
                const status = { type: "liveStatus", running: true, canRead: true, canWrite: true, source: "openocd" };
                const tree = (gain, address = 0x20000400) => ({
                    kind: "class",
                    typeName: "Motor",
                    members: [
                        {
                            name: "gain",
                            kind: "scalar",
                            type: "f32",
                            typeName: "float",
                            address,
                            value: gain,
                            valueText: String(gain)
                        },
                        {
                            name: "enabled",
                            kind: "scalar",
                            type: "u8",
                            typeName: "bool",
                            address: address + 4,
                            value: 1
                        },
                        {
                            name: "limit",
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
                        samples: [{ name: "motor.value", tree: tree(gain, address) }]
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
                view.send(status);
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
                const input = view.document.querySelector(".write-input");
                input.value = "3";
                input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
                const request = view.messages.findLast((message) => message.type === "writeVariable");
                assert.strictEqual(request.name, "motor.value.gain");
                assert.strictEqual(request.address, undefined);
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
                assert.strictEqual(input.disabled, false);
                assert.strictEqual(input.value, "4");
                saved = view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
                view.send({ ...status, running: false, canRead: false, canWrite: false });
                assert(input.disabled);
                view.send(status);
                assert(input.disabled, "restart waits for a sample from the current connection");
                sample(5);
                await clock.advance(100);
                assert.strictEqual(input.disabled, false);
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
    await scenario("Restore dynamic boolean controls and refresh relocated write risk indicators", async () => {
        const clock = new FakeClock();
        const view = render(getModernWebviewContent({}, "en"), {}, { clock });
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
                    { name: "motor.value.enabled", type: "u8", min: 0, max: 1, value: 1, fromWatch: true },
                    {
                        name: "motor.value.gain",
                        type: "f32",
                        address: 0x20000400,
                        min: 0,
                        max: 10,
                        value: 2,
                        fromWatch: true
                    }
                ]
            });
            view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true, source: "openocd" });
            const sample = (address) =>
                view.send({
                    type: "liveCompositeSample",
                    samples: [
                        {
                            name: "motor.value",
                            tree: {
                                kind: "class",
                                typeName: "Motor",
                                members: [
                                    {
                                        name: "enabled",
                                        kind: "scalar",
                                        type: "u8",
                                        typeName: "bool",
                                        value: 1,
                                        address: 0x20000404
                                    },
                                    { name: "gain", kind: "scalar", type: "f32", value: 2, address }
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
            assert.strictEqual(input.disabled, false);
            input.value = "2";
            input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
            assert.strictEqual(view.messages.filter((message) => message.type === "writeVariable").length, 0);
            assert.strictEqual(input.value, "1");
            assert.strictEqual(rows[1].querySelector(".write-risk"), null);
            sample(0x20000402);
            await clock.advance(100);
            assert(rows[1].querySelector(".write-risk").dataset.tip.includes("20000402"));
            sample(0x20000400);
            await clock.advance(100);
            assert.strictEqual(rows[1].querySelector(".write-risk"), null);
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
        menu.sampled([{ name: "value", value: 3 }]);
        assert.strictEqual(menu.entry("value").key, "sb.writeTypeUnknown");
        symbol.hasDwarfWriteType = true;
        assert.strictEqual(menu.entry("value").entry.type, "u32");
    });

    console.log("Watch-list write menu, dynamic qualifiers, sampling gates and stale results passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
