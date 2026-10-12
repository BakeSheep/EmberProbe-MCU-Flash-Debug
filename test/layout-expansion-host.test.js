"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const { loadProvider } = require("./helpers/load-provider");
const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { fixture, handle } = require("./helpers/layout-expansion-fixture");
function deepElf(count = 100) {
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
    info.push(5, ...str("root"), ...u32(target), 5, 3, ...u32(0x20000000), 0);
    const bytes = Buffer.from(info);
    bytes.writeUInt32LE(bytes.length - 4);
    const abbrev = Buffer.from([
        1, 0x11, 1, 0, 0, 2, 0x24, 0, 3, 8, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 3, 8, 0x0b, 0x0b, 0, 0, 4, 0x0d,
        0, 3, 8, 0x49, 0x13, 0x38, 0x0b, 0, 0, 5, 0x34, 0, 3, 8, 0x49, 0x13, 2, 0x18, 0, 0, 0
    ]);
    return buildElf32({
        sections: [
            { name: ".data", flags: 3, addr: 0x20000000, data: Buffer.alloc(4) },
            ...buildDebugSections({ info: bytes, abbrev })
        ],
        symbols: [{ name: "root", value: 0x20000000, size: 4 }]
    });
}
(async () => {
    const f = fixture();
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    const messages = [],
        sidebar = [],
        graph = [];
    Object.assign(provider, {
        _elfService: f.service,
        _webviewView: { webview: { postMessage: (reply) => sidebar.push(reply) } },
        _livePanels: new Map([[1, { post: (reply) => graph.push(reply) }]]),
        _watchLists: { invalidate() {} },
        _syncSidebarTarget() {},
        _syncGraphTarget() {},
        _refreshSamplingPlan: async () => {}
    });
    const request = { name: "axes", path: "axes[0].a.b", handle: handle(), generation: 7, version: "v1" };
    for (const invalid of [
        { handle: {} },
        { handle: "type:42" },
        { generation: "7" },
        { generation: -1 },
        { name: "axes.a" },
        { name: "missing" },
        { path: "axes[1].missing" },
        { path: "axes[*].a.b" },
        { path: "other.a.b" },
        { path: "axes[0].a.b->x" },
        { path: "axes[0].a.b.gain" },
        { path: "axes[999].a.b" },
        { path: "axes" },
        { path: "axes[0].a.b" + ".x".repeat(300) },
        { handle: handle("Mg") }
    ]) {
        await provider._handleLayoutExpansion({ ...request, ...invalid }, (reply) => messages.push(reply));
        assert(!messages.at(-1).layout);
        assert(["INVALID_LAYOUT_HANDLE", "INVALID_VARIABLE_PATH"].includes(messages.at(-1).code));
    }
    await provider._handleLayoutExpansion(request, (reply) => messages.push(reply));
    assert.strictEqual(messages.at(-1).layout, f.sublayout);
    assert.strictEqual(sidebar.at(-1).layout, f.sublayout);
    assert.strictEqual(graph.at(-1).layout, f.sublayout);
    await assert.rejects(provider._expandElfLayout({ ...request, generation: 6 }), { code: "STALE_LAYOUT_HANDLE" });
    await assert.rejects(provider._expandElfLayout({ ...request, version: "old" }), { code: "STALE_LAYOUT_HANDLE" });
    f.service.invalidate();
    await provider._handleLayoutExpansion(request, (reply) => messages.push(reply));
    assert.strictEqual(messages.at(-1).code, "STALE_LAYOUT_HANDLE");

    const malformed = fixture();
    malformed.service.expandLayout = async () => ({ ...malformed.sublayout, byteSize: 99 });
    await assert.rejects(malformed.service.expandSymbolLayout("axes", request.path, handle(), 7), {
        code: "INVALID_COMPOSITE_LAYOUT"
    });
    assert.strictEqual(malformed.symbol.layoutExpansions, undefined);
    let complete;
    malformed.service.expandLayout = () =>
        new Promise((resolve) => {
            complete = resolve;
        });
    const pending = malformed.service.expandSymbolLayout("axes", request.path, handle(), 7);
    await new Promise((resolve) => setImmediate(resolve));
    malformed.service.invalidate();
    complete(malformed.sublayout);
    await assert.rejects(pending, { code: "STALE_LAYOUT_HANDLE" });
    assert.strictEqual(malformed.symbol.layoutExpansions, undefined);

    // Exercise the real Worker and host through successive independent 32-edge windows.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-layout-host-"));
    const file = path.join(temp, "deep.elf");
    fs.writeFileSync(file, deepElf());
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols: elf,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.join(__dirname, "../src/elfWorker.js")
    });
    try {
        await service.ready();
        await service.layout("root");
        provider._elfService = service;
        let branchPath = "root",
            count = 0;
        while (true) {
            const symbol = service.symbolByName.get("root");
            const leaves = elf.expandCompositeLeaves(symbol, symbol.compositeLayout);
            if (leaves.length) {
                assert.strictEqual(leaves[0].path, "root" + ".next".repeat(100));
                assert.strictEqual(leaves[0].address, 0x20000000);
                break;
            }
            let node = elf.resolveLayoutPath(symbol, symbol.compositeLayout, elf.parseMemberPath(branchPath)).node;
            node = node.compositeLayout || node;
            while (!node.unobservable) {
                const member = node.members[0];
                branchPath += "." + member.name;
                node = member.compositeLayout || member;
            }
            await provider._expandElfLayout({
                name: "root",
                path: branchPath,
                handle: node.expansionHandle,
                generation: service.generation,
                version: provider._elfVersion(service.cache)
            });
            assert(++count <= 4);
        }
        assert(count >= 2, "recursive expansion crosses multiple root depth windows");
        const symbol = service.symbolByName.get("root");
        const original = Object.keys(symbol.layoutExpansions)[0];
        const oldNode = elf.resolveLayoutPath(symbol, symbol.compositeLayout, elf.parseMemberPath(original), {
            finalExpansion: false
        }).node;
        const oldRequest = {
            name: "root",
            path: original,
            handle: oldNode.expansionHandle,
            generation: service.generation,
            version: provider._elfVersion(service.cache)
        };
        service.invalidate();
        await service.ready();
        await service.layout("root");
        await assert.rejects(provider._expandElfLayout(oldRequest), { code: "STALE_LAYOUT_HANDLE" });
        await assert.rejects(provider._expandElfLayout({ ...oldRequest, generation: service.generation }), {
            code: "INVALID_LAYOUT_HANDLE"
        });
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log("Expansion message validation, broadcast, detached Worker recursion and stale ELF tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
