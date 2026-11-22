"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { loadProvider, createProvider } = require("./helpers/load-provider");
const { scenario } = require("./helpers/scenario");
const { CACHE_KEYS } = require("../src/cacheKeys");

const symbols = Array.from({ length: 80 }, (_, index) => ({
    name: `app::group${index}::counter`,
    address: 0x20000000 + index * 4,
    size: 4,
    watchType: "u32",
    hasDwarfWriteType: true
}));
const composite = {
    name: "plant",
    address: 0x20001000,
    size: 4,
    isComposite: true,
    compositeLayout: {
        kind: "struct",
        members: [{ name: "value", offset: 0, byteSize: 4, watchType: "u32" }]
    }
};
const view = render(getModernWebviewContent({}, "en"));
try {
    view.send({ type: "availableVariables", symbols: [...symbols, composite] });
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true });
    const box = view.document.getElementById("availableVars");
    const rows = Array.from(box.querySelectorAll(".available-row"));
    const row = rows[60];
    const watch = row.querySelector(".av-watch");
    const write = row.querySelector(".av-write");
    box.scrollTop = 900;
    box.scrollLeft = 3;
    watch.focus();
    watch.click();
    assert.strictEqual(box.querySelectorAll(".available-row")[60], row, "adding a watch keeps the ELF row");
    assert.strictEqual(view.document.activeElement, watch);
    assert.strictEqual(box.scrollTop, 900);
    assert.strictEqual(watch.textContent, "\u2713");
    watch.click();
    assert.strictEqual(watch.textContent, "+");
    write.click();
    assert(write.classList.contains("on"));
    assert.strictEqual(view.document.querySelector(".write-name-wrap .value-name").textContent, ".counter");
    const input = view.document.querySelector(".write-input");
    input.focus();
    input.value = "7";
    input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
    const request = view.messages.findLast((message) => message.type === "writeVariable");
    assert.strictEqual(request.name, symbols[60].name, "the shortened label never changes the write identity");
    assert.strictEqual(request.value, 7);
    assert(input.classList.contains("pending"));
    for (const canWrite of [false, true]) {
        view.send({
            type: "liveStatus",
            running: true,
            canRead: true,
            canWrite,
            source: "dap",
            snapshotReady: canWrite
        });
        assert.strictEqual(view.document.querySelector(".write-input"), input, "write gating keeps the active card");
        assert.strictEqual(input.disabled, !canWrite);
        assert(input.classList.contains("pending"));
    }
    view.send({ ...request, type: "writeResult", ok: true, value: 7 });
    assert(!input.classList.contains("pending"));
    view.send({ type: "liveSample", samples: [{ name: symbols[60].name, value: 7 }] });
    // A rejected write rolls the card back to the value still on the target.
    const savedWrite = () => view.messages.findLast((message) => message.type === "saveSidebarWrite").items[0];
    input.value = "9";
    input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
    const rejected = view.messages.findLast((message) => message.type === "writeVariable");
    assert.strictEqual(rejected.value, 9);
    view.send({ ...rejected, type: "writeResult", ok: false, message: "rejected" });
    assert.strictEqual(input.value, "7", "a failed write shows the target value again");
    assert.strictEqual(savedWrite().value, 7, "the rejected value is not persisted");
    view.document.querySelectorAll(".write-row .step-btn")[1].click();
    assert.strictEqual(view.messages.findLast((message) => message.type === "writeVariable").value, 8);
    view.send({
        ...view.messages.findLast((message) => message.type === "writeVariable"),
        type: "writeResult",
        ok: true,
        value: 8
    });
    assert.deepStrictEqual(Array.from(box.querySelectorAll(".available-row")), rows);
    assert.strictEqual(box.scrollTop, 900);
    view.document.querySelector(".write-row .watch-remove").click();
    assert(!write.classList.contains("on"));
    assert.strictEqual(box.querySelectorAll(".available-row")[60], row);

    // Whole composites and leaf selections also update their buttons in place.
    box.querySelector(".av-arrow").click();
    const leaf = box.querySelector(".available-row.leaf");
    const leafWatch = leaf.querySelector(".av-watch");
    leafWatch.click();
    assert.strictEqual(box.querySelector(".available-row.leaf"), leaf);
    assert(leafWatch.classList.contains("on"));
    box.querySelector(".available-row.comp .av-watch").click();
    view.document.querySelector(".value-row.composite .watch-remove").click();
    assert(!leafWatch.classList.contains("on"), "removing a composite also clears its leaf selections");
    leaf.querySelector(".av-write").click();
    assert.strictEqual(view.document.querySelector(".write-name-wrap .value-name").textContent, ".value");

    // Model a browser clamping scroll offsets when its old children are replaced.
    const replaceChildren = box.replaceChildren.bind(box);
    box.replaceChildren = (...nodes) => {
        replaceChildren(...nodes);
        box.scrollTop = 0;
        box.scrollLeft = 0;
    };
    box.scrollTop = 600;
    box.scrollLeft = 5;
    view.send({ type: "compositeLayoutResult", name: composite.name, version: "", layout: composite.compositeLayout });
    assert.strictEqual(box.scrollTop, 600, "real layout updates restore scroll offsets");
    assert.strictEqual(box.scrollLeft, 5);
    const search = view.document.getElementById("varSearch");
    search.value = "group79";
    search.dispatchEvent(new view.window.Event("input"));
    assert.strictEqual(box.scrollTop, 0, "a new filter starts at its first result");
    assert.strictEqual(box.querySelectorAll(".available-row").length, 1);
    view.assertHealthy();
} finally {
    view.close();
}

// Pointer members are read-only like top-level pointers: no write button is offered.
{
    const pointerView = render(getModernWebviewContent({}, "en"));
    try {
        const holder = {
            name: "holder",
            address: 0x20002000,
            size: 8,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                byteSize: 8,
                members: [
                    { name: "count", offset: 0, byteSize: 4, watchType: "u32" },
                    { name: "next", offset: 4, byteSize: 4, watchType: "u32", isPointer: true, pointerTarget: "data" }
                ]
            }
        };
        pointerView.send({ type: "availableVariables", symbols: [holder] });
        pointerView.send({ type: "liveStatus", running: true, canRead: true, canWrite: true });
        const pointerBox = pointerView.document.getElementById("availableVars");
        pointerBox.querySelector(".av-arrow").click();
        const writeButton = (name) => pointerBox.querySelector(`[data-picker-path="holder.${name}"] .av-write`);
        assert.strictEqual(writeButton("count").disabled, false);
        assert.strictEqual(writeButton("next").disabled, true, "pointer members cannot be added to the write list");
        pointerView.assertHealthy();
    } finally {
        pointerView.close();
    }
}

(async () => {
    await scenario("Only add ELF scalars that have static writable storage", async () => {
        const picker = render(getModernWebviewContent({}, "en"));
        try {
            const scalar = { name: "mutable", address: 0x20000000, size: 4, watchType: "u32", hasDwarfWriteType: true };
            const types = [
                { kind: "scalar", byteSize: 4, watchType: "u32", typeName: "unsigned int" },
                { kind: "class", stl: "vector", args: [0], byteSize: 12, typeName: "std::vector<unsigned int>" }
            ];
            picker.send({
                type: "availableVariables",
                writeRanges: [{ start: 0x20000000, end: 0x20000100 }],
                symbols: [
                    scalar,
                    { ...scalar, name: "constant", address: scalar.address + 4, isConst: true },
                    { ...scalar, name: "flash", address: 0x08000000 },
                    { ...scalar, name: "ref", address: scalar.address + 8, isReference: true },
                    {
                        ...scalar,
                        name: "values",
                        address: scalar.address + 12,
                        size: 12,
                        isComposite: true,
                        runtimeLayout: { root: 1, types }
                    }
                ]
            });
            const box = picker.document.getElementById("availableVars");
            const find = (name) =>
                [...box.querySelectorAll(".av-write")].find((button) => button.dataset.selectionName === name);
            assert.strictEqual(find("mutable").disabled, false);
            for (const name of ["constant", "flash", "ref"]) assert(find(name).disabled, name);
            box.querySelector(".av-arrow").click();
            assert(!find("values") || find("values").disabled);
            assert(
                ![...box.querySelectorAll(".av-write")].some(
                    (button) => button.dataset.selectionName.startsWith("values") && !button.disabled
                )
            );
            find("mutable").click();
            assert.deepStrictEqual(
                picker.messages
                    .findLast((message) => message.type === "saveSidebarWrite")
                    .items.map((item) => item.name),
                ["mutable"]
            );
            picker.assertHealthy();
        } finally {
            picker.close();
        }
    });
    const provider = Object.create(loadProvider().prototype);
    await scenario("Preserve the original binding during workspace write-list normalization", async () => {
        const fixture = createProvider();
        try {
            const symbol = {
                name: "selected",
                address: 0x20000004,
                size: 4,
                watchType: "u32",
                hasDwarfWriteType: true
            };
            const binding = { address: 0x20000000, type: "u32", size: 4, isBoolean: false, typeName: "unsigned int" };
            const normalize = (item) =>
                fixture.provider._watchLists.normalize([item], [symbol], CACHE_KEYS.sidebarWriteList);
            const legacy = { name: symbol.name, type: "u32", value: 2, fromWatch: true };
            assert.deepStrictEqual(fixture.provider._watchIdentities(normalize(legacy)), [legacy]);
            const pinned = { ...legacy, writeBinding: binding };
            assert.deepStrictEqual(fixture.provider._watchIdentities(normalize(pinned)), [pinned]);
        } finally {
            await fixture.dispose();
        }
    });
    for (const destination of ["write", "sidebarWrite", "invalid"])
        await assert.rejects(provider._agentOps.addWatch({ variables: ["counter"], destination }), {
            code: "INVALID_DESTINATION"
        });
    console.log("Write list identity, ELF scroll stability, gating and Agent destination audit passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
