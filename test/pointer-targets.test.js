"use strict";
// Pointer cells show their target instead of the address (kept in the tooltip and copied on
// click), C strings come from read-only ELF data, peripheral targets from the SVD, and data
// pointers expand in place in both webviews through read-only `<path>.value` watches.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const runtime = require("../src/webview/runtime");
const { ElfService } = require("../src/services/elfService");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { LiveWatchService, buildActiveReadPlan } = require("../src/services/liveWatchService");
const { PointerSymbolizer, layoutPathAt } = require("../src/services/pointerSymbolizer");
const { loadProvider } = require("./helpers/load-provider");
const { normalizeWatchList } = require("../src/validation");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const fixture = require("./fixtures/pointer-targets/elf.json");

const tables = { zh: require("../src/i18n/zh"), en: require("../src/i18n/en") };
const t = (key) => tables.en[key] ?? key;

// Pure label rules: unqualified targets, qualified tooltips, copied addresses.
assert.strictEqual(runtime.shortSymbolName("lab::g_widgets"), "g_widgets");
assert.strictEqual(runtime.shortSymbolName("ns::Box<a::B>::value"), "value");
assert.strictEqual(runtime.shortSymbolName("(anonymous namespace)::table"), "table");
assert.strictEqual(runtime.shortSymbolName("lab::tick(lab::Widget&)"), "tick(lab::Widget&)");
const label = (pointerInfo, extra = {}) => runtime.pointerLabel({ value: 0x2000001c, pointerInfo, ...extra }, t);
assert.deepStrictEqual(label({ kind: "data", name: "lab::g_widgets", offset: 28, index: 1 }), {
    text: "&g_widgets[1]",
    title: "0x2000001C → &lab::g_widgets[1]",
    copy: "0x2000001C"
});
assert.strictEqual(label({ kind: "data", name: "lab::buf", offset: 3 }).text, "&buf+0x3");
assert.strictEqual(label({ kind: "function", name: "lab::tick(lab::Widget&)", offset: 0 }).text, "tick()");
assert.strictEqual(label({ kind: "function", name: "lab::tick", offset: 4 }).text, "tick+0x4");
assert.strictEqual(label({ kind: "function", name: "lab::tick", offset: 0 }).title, "0x2000001C → lab::tick");
assert.strictEqual(label({ kind: "vtable", name: "lab::Motor", dynamicTypeName: "lab::Motor" }).text, "Motor");
assert.strictEqual(label({ kind: "peripheral", name: "GPIOA->ODR", offset: 2 }).text, "&GPIOA->ODR+0x2");
assert.deepStrictEqual(label({ kind: "region", region: "ram" }), {
    text: "0x2000001C",
    title: "0x2000001C → RAM",
    copy: "0x2000001C"
});
assert.strictEqual(label({ kind: "invalid" }).invalid, true);
assert.strictEqual(label({ kind: "invalid" }).text, "0x2000001C");
assert.strictEqual(label(null, { pointerString: '"motor"' }).text, '"motor"');
assert.strictEqual(runtime.pointerLabel({ value: 0 }, (key) => tables.zh[key]).text, "NULL");
for (const lang of ["zh", "en"])
    for (const key of ["lw.pointeeNull", "lw.pointerInvalid", "lw.pointerTarget", "lw.pointerRegion.peripheral"])
        assert.ok(tables[lang][key], lang + " " + key);
assert.ok(runtime.isPointeeEntry({ name: "a.p.value", derefPath: true }));
assert.ok(!runtime.isPointeeEntry({ name: "a.p->x", derefPath: true }));
assert.ok(runtime.isPointeeDescendant({ name: "a.p.value.q.value", derefPath: true }, "a.p.value"));
assert.ok(!runtime.isPointeeDescendant({ name: "a.p.valueX.value", derefPath: true }, "a.p.value"));

const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-pointer-targets-"));
(async () => {
    try {
        const buffer = zlib.inflateSync(Buffer.from(fixture.dwarf5, "base64"));
        const file = path.join(temporary, "fixture.elf");
        fs.writeFileSync(file, buffer);
        const parsed = dwarf.parseDwarf(buffer, { runtime: true });
        const result = elf.parseElfSymbols(buffer);
        result.memory = elf.parseElfSections(buffer);
        const stat = fs.statSync(file);
        result.elf = { path: file, size: stat.size, mtimeMs: stat.mtimeMs, sha256: "fixture" };
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        for (const fn of result.functions) fn.displayName = parsed.displayNames?.get(fn.name) || fn.name;
        const symbols = result.symbols;
        const symbol = (name) => symbols.find((entry) => entry.displayName === name);
        const nameOf = (name) => symbol(name).name;

        // Target memory: the ELF's allocated PROGBITS image plus the links main() makes.
        const memory = result.memory.sections
            .filter((section) => section.flags & 2 && section.type === 1 && section.size)
            .map((section) => ({
                start: section.addr,
                bytes: Buffer.from(buffer.subarray(section.offset, section.offset + section.size))
            }));
        const ranges = memory.map((entry) => ({ start: entry.start, end: entry.start + entry.bytes.length }));
        const locate = (address) =>
            memory.find((entry) => address >= entry.start && address < entry.start + entry.bytes.length);
        const read = async (address, size) => {
            const entry = locate(address);
            return entry.bytes.subarray(address - entry.start, address - entry.start + size);
        };
        const write32 = (address, value) => {
            const entry = locate(address);
            entry.bytes.writeUInt32LE(value >>> 0, address - entry.start);
        };
        const widgets = symbol("lab::g_widgets").address;
        const table = symbol("lab::g_widgetTable").address;
        write32(widgets + 28 + 20, widgets);
        write32(widgets + 56 + 20, widgets + 28);

        // Strings are read from the ELF file's read-only sections, never from the target.
        const symbolizer = new PointerSymbolizer(result);
        const nameAddress = (await read(symbol("lab::g_name").address, 4)).readUInt32LE(0);
        assert.strictEqual(symbolizer.stringAt(nameAddress), '"hello"');
        assert.strictEqual(symbolizer.stringAt(symbol("lab::g_ramText").address), null, "RAM data can change");
        const opened = [];
        const counting = new PointerSymbolizer(result, {
            fileSystem: { ...fs, openSync: (...args) => (opened.push(args[0]), fs.openSync(...args)) }
        });
        counting.stringAt(nameAddress);
        counting.stringAt(nameAddress);
        assert.strictEqual(opened.length, 1, "string reads are cached per ELF");
        const stale = new PointerSymbolizer({ ...result, elf: { ...result.elf, mtimeMs: result.elf.mtimeMs - 1 } });
        assert.strictEqual(stale.stringAt(nameAddress), null, "a rebuilt ELF is not read with old addresses");

        // SVD registers name peripheral targets until the binding is cleared.
        symbolizer.updatePeripherals({
            peripherals: [{ registers: [{ path: "GPIOA.ODR", address: 0x40020014, size: 32 }] }]
        });
        assert.deepStrictEqual(symbolizer.resolve(0x40020016), {
            kind: "peripheral",
            region: "peripheral",
            name: "GPIOA->ODR",
            offset: 2,
            text: "→ &GPIOA->ODR+0x2"
        });
        symbolizer.updatePeripherals(null);
        assert.strictEqual(symbolizer.resolve(0x40020014).kind, "region");

        // Offsets inside composite targets become member paths, the outermost object first.
        const layoutOf = (name) => symbol(name).compositeLayout;
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_widgets"), 0x40), { path: "[2].y", rest: 0 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_widgets"), 0x38), { path: "[2]", rest: 0 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_widgets"), 0x42), { path: "[2].y", rest: 2 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_square"), 8), { path: ".w", rest: 0 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_square"), 12), { path: ".span", rest: 0 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_square"), 14), { path: ".span.hi", rest: 0 });
        assert.deepStrictEqual(layoutPathAt(layoutOf("lab::g_grid"), 20), { path: "[1][2]", rest: 0 });
        assert.strictEqual(layoutPathAt(layoutOf("lab::g_grid"), 24), null, "past the end stays an offset");
        assert.strictEqual(layoutPathAt(layoutOf("lab::g_square"), 0), null);
        const inner = symbolizer.resolve(symbol("lab::g_widgets").address + 0x40);
        assert.strictEqual(inner.text, "→ &lab::g_widgets[2].y");
        assert.deepStrictEqual([inner.memberPath, inner.memberOffset, inner.offset], ["[2].y", 0, 0x40]);
        assert.strictEqual(
            runtime.pointerLabel({ value: 0x20000040, pointerInfo: inner }, t).text,
            "&g_widgets[2].y",
            "member paths replace raw offsets"
        );
        // Layouts the host has not loaded yet are requested once; the next sample shows the member.
        const lazySymbols = symbols.map((entry) =>
            entry.displayName === "lab::g_square" ? { ...entry, compositeLayout: null } : entry
        );
        const square = lazySymbols.find((entry) => entry.displayName === "lab::g_square");
        const requested = [];
        const lazy = new PointerSymbolizer(
            { ...result, symbols: lazySymbols },
            {
                requestLayout: async (name) => {
                    requested.push(name);
                    square.compositeLayout = symbol("lab::g_square").compositeLayout;
                }
            }
        );
        assert.strictEqual(lazy.resolve(square.address + 8).text, "→ &lab::g_square+0x8");
        lazy.resolve(square.address + 8);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(requested, [square.name], "one layout request per symbol");
        assert.strictEqual(lazy.resolve(square.address + 8).text, "→ &lab::g_square.w");

        const service = new LiveWatchService(elf, new PointerSymbolizer());
        service.setElfResult(result, true);
        service.setPeripheralModel({
            peripherals: [{ registers: [{ path: "GPIOA.ODR", address: 0x40020014, size: 32 }] }]
        });
        // Host pipeline: normalize the webview list, read it, decode and annotate like the provider.
        const sample = async (items) => {
            const hostItems = normalizeWatchList(items, symbols);
            const typeMap = new Map();
            const compositeMap = new Map();
            const raw = [];
            for (const item of hostItems) {
                typeMap.set(item.name, item.isPointer ? item : item.type);
                if (item.isComposite && item.compositeLayout)
                    compositeMap.set(item.name, { ...item, layout: item.compositeLayout });
                try {
                    raw.push(
                        item.runtimeLayout
                            ? {
                                  name: item.name,
                                  runtimeTree: await new RuntimeObjectReader(
                                      { ...item, runtimeRanges: ranges },
                                      read
                                  ).sample()
                              }
                            : { name: item.name, bytes: Buffer.from(await read(item.address, item.size)) }
                    );
                } catch (error) {
                    raw.push({ name: item.name, diagnostic: { code: error.code, message: error.message } });
                }
            }
            return service.decodeConsumerSamples(raw, Date.now(), typeMap, compositeMap);
        };

        for (const sidebar of [true, false]) {
            const view = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            const list = sidebar ? "availableVariables" : "variablesList";
            const saveType = sidebar ? "saveSidebarWatch" : "saveWatch";
            let items = ["lab::g_focus", "lab::g_widgetTable", "lab::g_name", "lab::g_hook", "lab::g_counterPtr"]
                .concat(["lab::g_reg", "lab::g_innerFloat", "lab::g_namedView", "lab::g_spanHi", "lab::g_gridCell"])
                .concat(["lab::g_widgets"])
                .map((name) => ({ ...symbol(name) }));
            const pump = async () => {
                const decoded = await sample(items);
                view.send({ type: "liveCompositeSample", samples: decoded.compositeSamples });
                view.send({ type: "liveSample", samples: decoded.scalarSamples });
                if (sidebar) view.window.refreshDisplayedValues();
                else view.window.updateValues();
            };
            const click = async (pathName) => {
                view.document.querySelector('.pointer-toggle[data-path="' + pathName + '"]').click();
                items = view.messages.findLast((message) => message.type === saveType).items;
                await pump();
            };
            const row = (pathName) =>
                [...view.document.querySelectorAll("[data-path], .value-row, .var-card")].find(
                    (element) =>
                        element.dataset.path === pathName ||
                        element.querySelector("[data-value-name]")?.dataset.valueName === pathName ||
                        element.querySelector("[data-raw-name]")?.dataset.rawName === pathName
                );
            const cell = (pathName) =>
                row(pathName)?.querySelector(".sb-mval, .member-value, .value-number, .var-value");
            const count = () => view.document.getElementById(sidebar ? "watchCount" : "count").textContent;
            try {
                if (!sidebar) view.document.getElementById("import").click();
                view.send({ type: list + "Reset", version: "v1", generation: 1, warnings: [] });
                view.send({ type: list + "Chunk", version: "v1", symbols });
                view.send({ type: list + "Done", version: "v1", total: symbols.length, warnings: [] });
                view.send({ type: sidebar ? "sidebarWatchList" : "watchList", items });
                await pump();
                const focus = nameOf("lab::g_focus");
                const tableName = nameOf("lab::g_widgetTable");
                assert.strictEqual(cell(focus).textContent, "&g_widgets[1]");
                assert.strictEqual(cell(focus).title, "0x2000001C → &lab::g_widgets[1]");
                assert.strictEqual(cell(focus).dataset.copy, "0x2000001C");
                cell(focus).click();
                assert.strictEqual(view.messages.findLast((message) => message.type === "copyText").text, "0x2000001C");
                assert.strictEqual(cell(tableName + "[0]").textContent, "&g_widgets[0]");
                assert.ok(!/u32/.test(row(tableName + "[0]").textContent), "pointer elements keep their type");
                assert.match(row(tableName + "[0]").textContent, /Widget \*/);
                assert.strictEqual(cell(tableName + "[2]").textContent, "NULL");
                assert.ok(row(tableName + "[2]").classList.contains("pointer-null"));
                assert.strictEqual(cell(nameOf("lab::g_name")).textContent, '"hello"');
                assert.strictEqual(cell(nameOf("lab::g_hook")).textContent, "tick()");
                assert.strictEqual(cell(nameOf("lab::g_reg")).textContent, "&GPIOA->ODR");
                assert.strictEqual(view.document.querySelectorAll(".pointer-follow").length, 0);
                assert.ok(!row(nameOf("lab::g_hook")).querySelector(".pointer-toggle"), "functions do not expand");
                assert.strictEqual(cell(nameOf("lab::g_innerFloat")).textContent, "&g_widgets[2].y");
                assert.strictEqual(cell(nameOf("lab::g_namedView")).textContent, "&g_square.w");
                assert.strictEqual(cell(nameOf("lab::g_spanHi")).textContent, "&g_square.span.hi");
                assert.strictEqual(cell(nameOf("lab::g_gridCell")).textContent, "&g_grid[1][2]");
                assert.strictEqual(count(), "11");
                // Struct array elements keep a collapsible `[i]` head instead of flattening their members.
                const widgetsName = nameOf("lab::g_widgets");
                const elementHead = row(widgetsName + "[1].id").closest(
                    sidebar ? ".sb-members" : ".comp-members"
                ).previousElementSibling;
                assert.strictEqual(
                    elementHead.querySelector(sidebar ? ".sb-comp-name" : ".comp-name").textContent,
                    "[1]"
                );
                assert.match(elementHead.textContent, /Widget/);

                // Expanding nests the target below its row; nested pointers expand again.
                await click(tableName + "[1]");
                assert.ok(items.some((item) => item.name === tableName + "[1].value" && item.derefPath));
                assert.strictEqual(cell(tableName + "[1].value.id").textContent, "2");
                assert.strictEqual(cell(tableName + "[1].value.label").textContent, '"motor"');
                assert.strictEqual(
                    row(tableName + "[1].value.id").closest(".pointer-pointee").previousElementSibling,
                    row(tableName + "[1]")
                );
                await click(tableName + "[1].value.parent");
                assert.strictEqual(cell(tableName + "[1].value.parent.value.id").textContent, "1");
                assert.strictEqual(cell(tableName + "[1].value.parent.value.parent").textContent, "NULL");
                assert.strictEqual(count(), "11", "pointees are not separate watch cards");

                // Scalar targets are one row; in the chart panel they start hidden.
                await click(nameOf("lab::g_counterPtr"));
                const counter = nameOf("lab::g_counterPtr") + ".value";
                assert.strictEqual(cell(counter).textContent, "42");
                assert.strictEqual(row(counter).querySelector(".sb-mname, .member-name").textContent, "*g_counterPtr");
                if (!sidebar) assert.ok(row(counter).querySelector(".member-swatch").classList.contains("off"));

                // A target that becomes NULL hides its body; the toggle follows the row's NULL state.
                write32(table + 4, 0);
                await pump();
                assert.ok(row(tableName + "[1]").classList.contains("pointer-null"));
                assert.strictEqual(cell(tableName + "[1]").textContent, "NULL");
                write32(table + 4, widgets + 28);
                await pump();
                assert.ok(!row(tableName + "[1]").classList.contains("pointer-null"));

                // Collapsing removes the target watch and everything expanded below it.
                await click(tableName + "[1]");
                assert.ok(!items.some((item) => item.name.startsWith(tableName + "[1].value")));
                assert.ok(!row(tableName + "[1].value.id"));

                // Pointees without a visible pointer row (older lists) remain cards with the target type.
                items = [{ name: tableName + "[3].value" }];
                view.send({
                    type: sidebar ? "sidebarWatchList" : "watchList",
                    items: normalizeWatchList(items, symbols)
                });
                write32(table + 12, 0);
                await pump();
                assert.strictEqual(count(), "1");
                const card = view.document.querySelector(sidebar ? ".value-row.composite" : ".var-card.composite");
                if (sidebar) assert.match(card.querySelector(".sb-comp-type").textContent, /Widget$/);
                assert.ok(card.textContent.includes(tables.en["lw.pointeeNull"]), "NULL targets are localized");
                assert.ok(!card.textContent.includes("Runtime pointer is null"));
                write32(table + 12, widgets + 56);
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
        // Members charted from an expanded pointee add no reads: their values come from its tree.
        {
            const focusName = nameOf("lab::g_focus");
            const members = [focusName + ".value.id", focusName + ".value.speed"];
            const list = normalizeWatchList(
                [{ name: focusName }, { name: focusName + ".value" }, ...members.map((name) => ({ name }))],
                symbols
            );
            assert.ok(list.filter((item) => members.includes(item.name)).every((item) => item.runtimeLayout));
            assert.deepStrictEqual(
                buildActiveReadPlan([list], elf).map((item) => item.name),
                [focusName, focusName + ".value"],
                "one read covers the pointee and its charted members"
            );
            assert.ok(
                buildActiveReadPlan([list, list.filter((item) => item.name === members[0])], elf).some(
                    (item) => item.name === members[0]
                ),
                "a list without the pointee still reads the member itself"
            );
            const decodePlan = async () => {
                const raw = [];
                for (const item of buildActiveReadPlan([list], elf))
                    try {
                        raw.push(
                            item.runtimeLayout
                                ? {
                                      name: item.name,
                                      runtimeTree: await new RuntimeObjectReader(
                                          { ...item, runtimeRanges: ranges },
                                          read
                                      ).sample()
                                  }
                                : { name: item.name, bytes: Buffer.from(await read(item.address, item.size)) }
                        );
                    } catch (error) {
                        raw.push({
                            name: item.name,
                            bytes: null,
                            diagnostic: { code: error.code, message: error.message }
                        });
                    }
                const types = new Map(list.map((item) => [item.name, item.isPointer ? item : item.type]));
                const composites = new Map(
                    list
                        .filter((item) => item.isComposite && item.compositeLayout)
                        .map((item) => [item.name, { ...item, layout: item.compositeLayout }])
                );
                return service.decodeConsumerSamples(raw, Date.now(), types, composites);
            };
            const values = (await decodePlan()).scalarSamples;
            assert.deepStrictEqual(
                members.map((name) => values.find((sample) => sample.name === name)?.value),
                [2, 1.5]
            );
            const focus = symbol("lab::g_focus").address;
            write32(focus, 0);
            const unavailable = (await decodePlan()).scalarSamples;
            assert.ok(
                members.every(
                    (name) =>
                        unavailable.find((sample) => sample.name === name)?.diagnostic.code === "LIVE_NULL_POINTER"
                ),
                "members follow their pointee's diagnostic"
            );
            write32(focus, widgets + 28);

            // The chart panel draws the member curves in the pointee rows, without separate cards.
            const view = render(getLiveWatchContent({}, "en"));
            try {
                view.document.getElementById("import").click();
                view.send({ type: "variablesListReset", version: "v1", generation: 1, warnings: [] });
                view.send({ type: "variablesListChunk", version: "v1", symbols });
                view.send({ type: "variablesListDone", version: "v1", total: symbols.length, warnings: [] });
                view.send({ type: "watchList", items: list });
                const decoded = await decodePlan();
                view.send({ type: "liveCompositeSample", samples: decoded.compositeSamples });
                view.send({ type: "liveSample", samples: decoded.scalarSamples });
                view.window.updateValues();
                const cards = [...view.document.querySelectorAll(".var-card")];
                assert.strictEqual(cards.length, 1, "only the pointer variable has a card");
                assert.strictEqual(view.document.getElementById("count").textContent, "1");
                for (const name of members) {
                    const row = view.document.querySelector('.member-row[data-path="' + name + '"]');
                    assert.ok(row?.closest(".pointer-pointee"), name + " stays in the pointee tree");
                    assert.ok(!row.querySelector(".member-swatch").classList.contains("off"), name + " is charted");
                }
                view.assertHealthy();
            } finally {
                view.close();
            }
        }

        // Progressive ELF loading: type updates carry pointer identity, and a lone pointer variable
        // requests its runtime type graph before it offers expansion.
        const Provider = loadProvider();
        const provider = Object.create(Provider.prototype);
        const updates = [];
        provider._webviewView = { webview: { postMessage: (message) => updates.push(message) } };
        provider._livePanels = new Map();
        const scalars = [
            "lab::g_counterPtr",
            "lab::g_innerFloat",
            "lab::g_namedView",
            "lab::g_spanHi",
            "lab::g_gridCell"
        ];
        provider._onElfChange("types", { elf: { sha256: "progressive" } }, scalars.map(symbol));
        const typeUpdate = updates.find((message) => message.type === "availableVariableTypes");
        assert.ok(typeUpdate.symbols.every((entry) => entry.isPointer && entry.pointerTarget === "data"));
        assert.ok(
            typeUpdate.symbols.every((entry) => !entry.runtimeLayout),
            "graphs stay lazy"
        );
        for (const sidebar of [true, false]) {
            const view = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            const list = sidebar ? "availableVariables" : "variablesList";
            try {
                if (!sidebar) view.document.getElementById("import").click();
                view.send({ type: list + "Reset", version: "progressive", generation: 1, warnings: [] });
                view.send({
                    type: list + "Chunk",
                    version: "progressive",
                    symbols: scalars.map((name) => {
                        const { name: raw, address, size } = symbol(name);
                        return { name: raw, displayName: raw, address, size };
                    })
                });
                view.send({ type: list + "Done", version: "progressive", total: scalars.length, warnings: [] });
                view.send({ ...typeUpdate, type: sidebar ? "availableVariableTypes" : "variableTypes" });
                view.send({ type: sidebar ? "availableTypesDone" : "variableTypesDone", version: "progressive" });
                const counterName = nameOf("lab::g_counterPtr");
                if (sidebar) {
                    const row = [...view.document.querySelectorAll(".available-row")].find(
                        (entry) => entry.querySelector(".available-name")?.dataset.rawName === counterName
                    );
                    row.click();
                } else view.send({ type: "watchList", items: normalizeWatchList([{ name: counterName }], symbols) });
                const card = view.document.querySelector(sidebar ? ".value-row" : ".var-card");
                assert.strictEqual(card.querySelector(".value-type, .member-type").textContent, "int *");
                assert.ok(!card.querySelector(".pointer-toggle"), "no expansion before the type graph");
                const request = view.messages.findLast((message) => message.type === "resolveCompositeLayout");
                assert.deepStrictEqual([request.name, request.version], [counterName, "progressive"]);
                view.send({
                    type: "compositeLayoutResult",
                    name: counterName,
                    version: "progressive",
                    layout: {
                        kind: "class",
                        byteSize: 4,
                        members: [],
                        runtimeLayout: symbol("lab::g_counterPtr").runtimeLayout
                    }
                });
                const toggle = view.document.querySelector('.pointer-toggle[data-path="' + counterName + '"]');
                assert.ok(toggle, "a lone pointer variable expands once its graph arrives");
                toggle.click();
                const saved = view.messages.findLast((message) => /^save(Sidebar)?Watch$/.test(message.type)).items;
                const pointee = saved.find((item) => item.name === counterName + ".value");
                assert.ok(pointee?.derefPath && pointee.runtimeLayout && pointee.type === "i32");
                const expanded = view.document.querySelector('.pointer-toggle[data-path="' + counterName + '"]');
                assert.strictEqual(expanded.getAttribute("aria-expanded"), "true");
                // A stand-alone pointer keeps its target inside its own card.
                const ownCard = expanded.parentElement;
                assert.ok(ownCard.matches(sidebar ? ".value-row" : ".var-card"));
                assert.ok(
                    ownCard.querySelector(':scope > .pointer-pointee.open [data-path="' + counterName + '.value"]')
                );
                assert.ok(!ownCard.nextElementSibling?.matches(".pointer-pointee"));
                assert.strictEqual(
                    view.messages.filter((message) => message.type === "resolveCompositeLayout").length,
                    1,
                    "the graph is requested once"
                );
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
        console.log("Pointer targets, strings, peripherals and in-place expansion passed / both webviews");
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
