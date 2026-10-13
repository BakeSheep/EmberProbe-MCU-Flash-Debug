"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../src/dwarf/constants");
const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { loadProvider } = require("./helpers/load-provider");
const elf = require("../src/elfSymbols");
const { createLayoutExpansion } = require("../src/dwarf/layoutExpansion");
const { EXPANSION_TYPE_REF, createCompositeLayoutResolver } = require("../src/dwarf/types");
const { createWorkerElfService } = require("./helpers/elf-service");

function deepElf(count = 50) {
    const info = [0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 1];
    const u32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
    const str = (value) => Array.from(Buffer.from(value + "\0"));
    const integer = info.length;
    info.push(2, ...str("int"), 5, 4);
    let target = integer;
    for (let index = count - 1; index >= 0; index--) {
        const ref = info.length;
        info.push(3, ...str("S" + index), 4, 4, ...str("next"), ...u32(target), 0, 0);
        target = ref;
    }
    const root = info.length;
    info.push(3, ...str("Root"), 8, 4, ...str("deep"), ...u32(target), 0, 4, ...str("good"), ...u32(integer), 4, 0);
    info.push(5, ...str("root"), ...u32(root), 5, 3, ...u32(0x20000000), 0);
    const bytes = Buffer.from(info);
    bytes.writeUInt32LE(bytes.length - 4);
    const abbrev = Buffer.from([
        1, 0x11, 1, 0, 0, 2, 0x24, 0, 3, 8, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 3, 8, 0x0b, 0x0b, 0, 0, 4, 0x0d,
        0, 3, 8, 0x49, 0x13, 0x38, 0x0b, 0, 0, 5, 0x34, 0, 3, 8, 0x49, 0x13, 2, 0x18, 0, 0, 0
    ]);
    return buildElf32({
        sections: [
            { name: ".data", flags: 3, addr: 0x20000000, data: Buffer.alloc(8) },
            ...buildDebugSections({ info: bytes, abbrev })
        ],
        symbols: [{ name: "root", value: 0x20000000, size: 8 }]
    });
}
function limitedMember(layout) {
    const pending = [layout];
    while (pending.length) {
        const node = pending.pop();
        if (node.unobservable) return node;
        for (const member of node.members || []) pending.push(member);
        if (node.compositeLayout) pending.push(node.compositeLayout);
        if (node.elementType) pending.push(node.elementType);
    }
    return null;
}
(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-deep-layout-"));
    const file = path.join(temp, "deep.elf");
    fs.writeFileSync(file, deepElf());
    const service = createWorkerElfService(file);
    try {
        await service.ready();
        const layout = await service.layout("root");
        const member = limitedMember(layout);
        assert.strictEqual(member.unobservable, "depth-limit");
        assert.ok(member.expansionHandle);
        const generation = layout.expansionGeneration;
        const expanded = await service.expandLayout(member.expansionHandle, generation);
        assert.strictEqual(expanded.kind, "struct");
        assert.strictEqual(expanded.truncated, undefined, "a fresh budget can fully resolve the remaining branch");
        assert.strictEqual(expanded.expansionGeneration, generation);
        assert.deepStrictEqual(await service.expandLayout(member.expansionHandle, generation), expanded);
        assert.strictEqual(member.compositeLayout, undefined, "expansion must not mutate the cached bounded root");
        assert.strictEqual(await service.layout("root"), layout);
        assert.strictEqual(service.layoutErrors.size, 0, "partial layouts are successful results");

        for (const invalid of [null, {}, 1, "type:42", member.expansionHandle + "x", "x".repeat(10000)])
            await assert.rejects(service.expandLayout(invalid, generation), { code: "INVALID_LAYOUT_HANDLE" });
        await assert.rejects(service.expandLayout(member.expansionHandle, "1"), { code: "INVALID_LAYOUT_HANDLE" });
        const forged = member.expansionHandle.slice(0, -1) + (member.expansionHandle.endsWith("a") ? "b" : "a");
        await assert.rejects(service.expandLayout(forged, generation), { code: "INVALID_LAYOUT_HANDLE" });
        assert.strictEqual(service.layoutErrors.size, 0, "invalid handles never poison symbol failure caching");

        const workerReply = new Promise((resolve) => {
            const listener = (message) => {
                if (message.id !== 98765) return;
                service.worker.removeListener("message", listener);
                resolve(message);
            };
            service.worker.on("message", listener);
        });
        service.worker.postMessage({ type: "expandLayout", id: 98765, handle: member.expansionHandle, generation: {} });
        assert.strictEqual((await workerReply).error.code, "INVALID_LAYOUT_HANDLE");

        const provider = Object.create(loadProvider().prototype);
        provider.readElfSymbols = () => service.read();
        provider._prepareRequestedLayouts = async () => {};
        const sym = service.symbolByName.get("root");
        const truncatedPath = "root.deep" + ".next".repeat(32);
        assert.deepStrictEqual(elf.expandCompositeLeaves(sym, layout, elf.parseMemberPath(truncatedPath)), []);
        for (const name of [truncatedPath, truncatedPath + ".next"]) {
            assert.throws(() => provider._agentWritePlan([{ name, value: 1 }], { refreshSymbols: false }), {
                code: "INVALID_VARIABLE_PATH"
            });
            await assert.rejects(provider._addAgentWatch({ variables: [name] }), { code: "INVALID_VARIABLE_PATH" });
        }
        assert.strictEqual(
            provider._agentWritePlan([{ name: "root.good", value: 1 }], { refreshSymbols: false }).items.length,
            1,
            "a shallow sibling retains its normal typed write authorization path"
        );

        const previousHandle = member.expansionHandle;
        service.invalidate();
        await assert.rejects(service.expandLayout(previousHandle, generation), { code: "STALE_LAYOUT_HANDLE" });
        await service.ready();
        const nextLayout = await service.layout("root");
        await assert.rejects(service.expandLayout(previousHandle, nextLayout.expansionGeneration), {
            code: "STALE_LAYOUT_HANDLE"
        });
        fs.writeFileSync(file, deepElf(60));
        await assert.rejects(
            service.expandLayout(limitedMember(nextLayout).expansionHandle, nextLayout.expansionGeneration),
            { code: "STALE_LAYOUT_HANDLE" }
        );
        assert.strictEqual(service.layoutErrors.size, 0);
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }

    // Unknown signed references still fail lookup; raw references are never accepted as handles.
    const parsed = {
        dies: new Map([[1, { tag: c.DW_TAG_structure_type, name: "S", byteSize: 4 }]]),
        childrenMap: new Map(),
        variables: [{ name: "s", typeRef: 1 }]
    };
    const resolver = createCompositeLayoutResolver(parsed);
    const expansion = createLayoutExpansion(resolver);
    const unavailable = { unobservable: "expansion-budget" };
    Object.defineProperty(unavailable, EXPANSION_TYPE_REF, { value: 999 });
    const token = expansion.annotate(unavailable).expansionHandle;
    assert.throws(() => expansion.expand(token), { code: "INVALID_LAYOUT_HANDLE" });
    assert.throws(() => expansion.expand({ typeRef: 1 }), { code: "INVALID_LAYOUT_HANDLE" });
    assert.strictEqual(expansion.annotate(null), null);
    const cycle = { unobservable: "type-cycle" };
    Object.defineProperty(cycle, EXPANSION_TYPE_REF, { value: 1 });
    assert.strictEqual(expansion.annotate(cycle).expansionHandle, undefined, "cycles cannot be lazily expanded");
    console.log("DWARF Worker/service expansion handles, stale ELF rejection and write safety tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
