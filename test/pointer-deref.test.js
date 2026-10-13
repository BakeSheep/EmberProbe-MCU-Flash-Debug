"use strict";
// On-demand pointer dereference: only explicit, user-requested `.value` paths follow raw
// pointers outside STL, never into void/function/incomplete targets, always read-only and
// within the runtime address whitelist and read budget.
const assert = require("assert");
const zlib = require("zlib");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { normalizeWatchList } = require("../src/validation");
const { memberPathSegments, pointerDerefEntry, runtimeWatchEntry } = require("../src/webview/runtime");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { render } = require("./helpers/render-webview");
const { loadProvider } = require("./helpers/load-provider");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

assert.deepStrictEqual(memberPathSegments("motor.@base0.parent->x[3]"), {
    base: "motor",
    segments: [
        { kind: "member", name: "@base0" },
        { kind: "member", name: "parent" },
        { kind: "dereference" },
        { kind: "member", name: "x" },
        { kind: "index", index: 3 }
    ]
});
assert.deepStrictEqual(memberPathSegments("counter"), { base: "counter", segments: [] });
assert.strictEqual(memberPathSegments("motor.bad-name"), null);

const fixture = require("./fixtures/pointer-classes/elf.json");
(async () => {
    for (const version of [4, 5]) {
        const buffer = zlib.inflateSync(Buffer.from(fixture[`dwarf${version}`], "base64"));
        const parsed = dwarf.parseDwarf(buffer, { runtime: true });
        const result = elf.parseElfSymbols(buffer);
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        const symbols = result.symbols;
        const symbol = (name) => symbols.find((entry) => entry.name === name);
        const motor = symbol("motor");
        const fleet = symbol("fleet");

        // Plain pointer members stay address values unless the path explicitly dereferences.
        assert.strictEqual(runtimeWatchEntry("motor", motor), null);
        assert.strictEqual(
            runtimeWatchEntry("motor.@base0.parent.x", motor, memberPathSegments("motor.@base0.parent.x").segments),
            null,
            "member access through a pointer requires an explicit dereference"
        );
        const parent = pointerDerefEntry("motor.@base0.parent", motor);
        assert.strictEqual(parent.name, "motor.@base0.parent.value");
        assert.strictEqual(parent.derefPath, true);
        assert.strictEqual(parent.runtimeStaticPointers, true, "pointers inside the target are not chased");
        assert.strictEqual(parent.isComposite, true);
        assert.strictEqual(parent.displayName, "*motor.@base0.parent");
        const arrow = runtimeWatchEntry(
            "motor.@base0.parent->x",
            motor,
            memberPathSegments("motor.@base0.parent->x").segments
        );
        assert.strictEqual(arrow.type, "i32");
        assert.strictEqual(arrow.derefPath, true);
        for (const opaque of ["motor.@base0.userData", "motor.@base0.onClick", "fleet.handle"])
            assert.strictEqual(
                pointerDerefEntry(opaque, symbol(opaque.split(".")[0])),
                null,
                `${opaque} has no safe target`
            );
        assert.strictEqual(pointerDerefEntry("motor.speed", motor), null, "non-pointers cannot be dereferenced");
        assert.strictEqual(pointerDerefEntry("motor.@base0.parent", fleet), null, "the base symbol must match");
        const label = pointerDerefEntry("motor.@base0.label", motor);
        assert.ok(["u8", "i8"].includes(label.type));
        assert.strictEqual(label.isComposite, false);
        const counter = pointerDerefEntry("counterPtr", symbol("counterPtr"));
        assert.strictEqual(counter.type, "i32");
        assert.strictEqual(counter.displayName, "*counterPtr");

        // The host re-validates saved entries by name, independently of webview metadata.
        const normalized = normalizeWatchList(
            [
                { name: "motor.@base0.parent.value" },
                { name: "motor.@base0.userData.value" },
                { name: "counterPtr.value" },
                { name: "motor.@base0.parent.x" }
            ],
            symbols
        );
        assert.deepStrictEqual(
            normalized.map((entry) => entry.name),
            ["motor.@base0.parent.value", "counterPtr.value"]
        );
        assert.ok(normalized.every((entry) => entry.derefPath && entry.runtimeLayout));

        // Runtime reads: one level of target, nested pointers stay addresses, char strings preview.
        const ram = { start: 0x20000000, end: 0x20000000 + 0x1000 };
        const flash = { start: 0x08000000, end: 0x08000000 + 0x400 };
        const memory = new Map();
        const region = (range) => {
            if (!memory.has(range.start)) memory.set(range.start, Buffer.alloc(range.end - range.start));
            return memory.get(range.start);
        };
        const locate = (address) => [ram, flash].find((range) => address >= range.start && address < range.end);
        const write32 = (address, value) =>
            region(locate(address)).writeUInt32LE(value >>> 0, address - locate(address).start);
        const reads = [];
        const read = async (address, size) => {
            reads.push([address, size]);
            const range = locate(address);
            return region(range).subarray(address - range.start, address - range.start + size);
        };
        const leaves = elf.expandCompositeLeaves({ ...motor, address: ram.start }, motor.compositeLayout, null);
        const offset = (path) => leaves.find((leaf) => leaf.path === path).address - ram.start;
        const other = ram.start + 0x200;
        write32(ram.start + offset("motor.@base0.parent"), other);
        write32(other + offset("motor.@base0.x"), 41);
        write32(other + offset("motor.@base0.parent"), ram.start);
        write32(ram.start + offset("motor.@base0.label"), flash.start + 0x10);
        region(flash).write("motor\0", 0x10, "latin1");
        const item = (entry) => ({ ...entry, address: ram.start, runtimeRanges: [ram, flash] });

        const tree = await new RuntimeObjectReader(item(parent), read).sample();
        assert.strictEqual(tree.typeName, "Widget", "the target is read with the pointer's static type");
        assert.strictEqual(tree.members.find((member) => member.name === "x").value, 41);
        const nested = tree.members.find((member) => member.name === "parent");
        assert.strictEqual(nested.kind, "scalar", "pointers inside the target remain address leaves");
        assert.strictEqual(nested.value, ram.start);
        assert.strictEqual(nested.isPointer, true);
        assert.ok(!reads.some(([address]) => address === ram.start + offset("motor.@base0.x")), "no second level");

        const text = await new RuntimeObjectReader(item(label), read).sample();
        assert.strictEqual(text.valueText, '"motor"');
        assert.strictEqual(text.value, "m".charCodeAt(0));
        assert.strictEqual(text.stringPreview, true);
        region(flash).write('tab\there\x01"q', 0x10, "latin1");
        region(flash).fill(0x41, 0x1b, 0x40);
        const escaped = await new RuntimeObjectReader(item(label), read).sample();
        assert.ok(escaped.valueText.startsWith('"tab\\x09here\\x01\\"q'));
        assert.ok(escaped.valueText.endsWith("…"), "an unterminated string is marked as truncated");

        write32(ram.start + offset("motor.@base0.parent"), 0);
        await assert.rejects(new RuntimeObjectReader(item(parent), read).sample(), { code: "LIVE_NULL_POINTER" });
        write32(ram.start + offset("motor.@base0.parent"), 0x40000000);
        reads.length = 0;
        await assert.rejects(new RuntimeObjectReader(item(parent), read).sample(), { code: "LIVE_ADDRESS_NOT_RAM" });
        assert.ok(!reads.some(([address]) => address >= 0x40000000), "MMIO targets are rejected before reading");
        write32(ram.start + offset("motor.@base0.label"), flash.end - 3);
        region(flash).write("abc", flash.end - flash.start - 3, "latin1");
        const clamped = await new RuntimeObjectReader(item(label), read).sample();
        assert.strictEqual(clamped.valueText, '"abc"…', "string previews never read past a verified range");
        // Both webviews offer the follow button only on dereferenceable data pointers.
        const bytes = Buffer.alloc(motor.size);
        bytes.writeUInt32LE(
            motor.address,
            leaves.find((leaf) => leaf.path === "motor.@base0.parent").address - ram.start
        );
        const sampleTree = elf.decodeComposite(bytes, motor.compositeLayout, motor);
        for (const sidebar of [false, true]) {
            const view = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            try {
                view.send({ type: sidebar ? "sidebarWatchList" : "watchList", items: [motor] });
                view.send({ type: "liveCompositeSample", samples: [{ name: "motor", tree: sampleTree }] });
                const buttons = [...view.document.querySelectorAll(".pointer-follow")].map(
                    (button) => button.dataset.path
                );
                assert.ok(buttons.includes("motor.@base0.parent"));
                assert.ok(buttons.includes("motor.@base0.label"));
                for (const opaque of ["motor.@base0.userData", "motor.@base0.onClick", "motor.rxBuffer.x"])
                    assert.ok(!buttons.includes(opaque), opaque + " has no follow button");
                view.document.querySelector('.pointer-follow[data-path="motor.@base0.parent"]').click();
                const saved = view.messages.findLast(
                    (message) => message.type === (sidebar ? "saveSidebarWatch" : "saveWatch")
                ).items;
                const added = saved.find((entry) => entry.name === "motor.@base0.parent.value");
                assert.ok(added?.runtimeLayout, "following adds a runtime watch for the target");
                assert.strictEqual(added.runtimeStaticPointers, true);
                assert.strictEqual(saved.filter((entry) => entry.name === added.name).length, 1);
                view.document.querySelector('.pointer-follow[data-path="motor.@base0.parent"]').click();
                assert.strictEqual(
                    view.messages
                        .findLast((message) => message.type === (sidebar ? "saveSidebarWatch" : "saveWatch"))
                        .items.filter((entry) => entry.name === added.name).length,
                    1,
                    "following twice does not duplicate or remove the target watch"
                );
                view.assertHealthy?.();
            } finally {
                view.close();
            }
        }

        // Dereferenced targets are never write destinations.
        const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-deref-"));
        try {
            const file = path.join(temporary, "fixture.elf");
            fs.writeFileSync(file, buffer);
            result.elf = { path: file };
            result.memory = elf.parseElfSections(buffer);
            const Provider = loadProvider();
            const provider = Object.create(Provider.prototype);
            provider.readElfSymbols = () => result;
            for (const name of ["motor.@base0.parent.value.x", "motor.@base0.parent->x", "counterPtr.value"])
                assert.throws(
                    () => provider._agentWritePlan([{ name, value: 1 }], { refreshSymbols: false }),
                    (error) => !!error.code,
                    name + " must not be writable"
                );
        } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    }
    console.log("On-demand pointer dereference paths, validation, reads and string previews passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
