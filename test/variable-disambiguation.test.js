"use strict";
const assert = require("assert");
const elf = require("../src/elfSymbols");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const raw = "_ZN12_GLOBAL__N_1L17g_sameNameCounterE";
const symbols = ["probe_lab.cpp", "probe_lab_peer.cpp"].map((file, index) => ({
    name: file + "::" + raw,
    elfName: raw,
    displayName: file + "::g_sameNameCounter",
    sameNameCount: 2,
    sourceFile: "/project/Core/Src/" + file,
    address: 0x20000484 + index * 4,
    size: 4,
    watchType: "u32",
    typeName: "uint32_t",
    hasDwarfWriteType: true
}));
const candidates = symbols.map(({ name, displayName, sourceFile, address, size }) => ({
    name,
    displayName,
    sourceFile,
    address: "0x" + address.toString(16).toUpperCase(),
    size
}));
for (const lang of ["en", "zh"]) {
    assert.throws(
        () => elf.createSymbolResolver(symbols)("g_sameNameCounter"),
        (error) => {
            assert.strictEqual(error.code, "VARIABLE_AMBIGUOUS");
            assert(!error.message.includes("_ZN"));
            assert.strictEqual(error.details.candidates[0].name, symbols[0].name);
            return true;
        }
    );
    const sidebar = render(getModernWebviewContent({}, lang));
    const graph = render(getLiveWatchContent({}, lang));
    try {
        sidebar.send({ type: "availableVariables", symbols });
        graph.send({ type: "variablesListReset", version: "elf1" });
        graph.send({ type: "variablesListChunk", version: "elf1", symbols });
        graph.send({ type: "variableTypesDone", version: "elf1" });
        graph.window.openImport();
        for (const [view, selector] of [
            [sidebar, ".available-name"],
            [graph, "#impList .imp-name"]
        ]) {
            const names = [...view.document.querySelectorAll(selector)];
            assert.strictEqual(names.length, 2);
            assert.deepStrictEqual(
                names.map((n) => n.querySelector(".symbol-name-label").textContent),
                ["g_sameNameCounter", "g_sameNameCounter"]
            );
            assert.deepStrictEqual(
                names.map((n) => n.querySelector(".symbol-source").textContent),
                ["probe_lab.cpp", "probe_lab_peer.cpp"]
            );
            assert(names[0].title.includes("/project/Core/Src/probe_lab.cpp"));
            assert(names[0].title.includes("0x20000484"));
            assert(!names[0].textContent.includes("_ZN"));
        }
        assert(sidebar.document.getElementById("availableDiagnostics").hidden);
        assert(graph.document.getElementById("importDiagnostics").hidden);
        graph.window.hideImport();
        const input = graph.document.getElementById("addName");
        const type = (value) => {
            input.focus();
            input.value = value;
            input.dispatchEvent(new graph.window.Event("input"));
        };
        const key = (value) =>
            input.dispatchEvent(new graph.window.KeyboardEvent("keydown", { key: value, cancelable: true }));
        const submit = () => {
            key("Enter");
            return graph.messages.at(-1);
        };
        const reply = (request, extra = {}) =>
            graph.send({
                type: "variableChoices",
                version: request.version,
                requestId: request.requestId,
                requestedName: request.name,
                candidates,
                ...extra
            });
        type("g_sameNameCounter");
        assert.strictEqual(graph.document.querySelectorAll("#acResults .symbol-source").length, 2);
        const request = submit();
        assert.strictEqual(request.type, "resolveVariable");
        assert.strictEqual(input.value, "g_sameNameCounter", "retain ambiguous input for choosing a source");
        assert(!graph.messages.some((m) => m.type === "saveWatch"));
        reply(request);
        assert.strictEqual(input.getAttribute("aria-expanded"), "true");
        assert.strictEqual(input.hasAttribute("aria-activedescendant"), false, "no implicit default candidate");
        assert(!graph.document.getElementById("acChoiceHint").hidden);
        assert.strictEqual(graph.document.querySelectorAll("#acResults .ac-item").length, 2);
        graph.send({ type: "setLang", lang: lang === "en" ? "zh" : "en" });
        assert(!graph.document.getElementById("acChoiceHint").hidden);
        key("ArrowDown");
        key("ArrowDown");
        key("Enter");
        const selected = graph.messages.at(-1);
        assert.strictEqual(selected.name, symbols[1].name, "selection submits the unique canonical identity");
        assert(!graph.messages.some((m) => m.type === "saveWatch"), "host validates the selected identity first");
        graph.send({
            type: "addResolved",
            version: "elf1",
            requestId: selected.requestId,
            requestedName: selected.name,
            symbol: symbols[1]
        });
        assert.strictEqual(graph.messages.at(-1).items[0].name, symbols[1].name);
        assert.strictEqual(input.value, "");
        assert.strictEqual(input.getAttribute("aria-expanded"), "false");

        // Editing, Escape, a later request with the same query, and ELF reload all cancel stale replies.
        type("g_sameNameCounter");
        const old = submit();
        graph.document.getElementById("run").focus();
        reply(old);
        assert.strictEqual(graph.document.activeElement.id, "run", "late choices cannot steal focus");
        assert.strictEqual(input.getAttribute("aria-expanded"), "false");
        type("different");
        reply(old);
        assert.strictEqual(input.value, "different");
        assert(graph.document.getElementById("acChoiceHint").hidden);
        type("g_sameNameCounter");
        const cancelled = submit();
        key("Escape");
        reply(cancelled);
        assert.strictEqual(input.getAttribute("aria-expanded"), "false");
        const newer = submit();
        reply(cancelled);
        assert.strictEqual(input.getAttribute("aria-expanded"), "false");
        reply(newer);
        graph.document
            .querySelector("#acResults .ac-item")
            .dispatchEvent(new graph.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        assert.strictEqual(
            graph.messages.at(-1).name,
            symbols[0].name,
            "mouse selection also uses the canonical identity"
        );
        const staleAdd = graph.messages.at(-1);
        type("changed");
        const savedCount = graph.messages.filter((m) => m.type === "saveWatch").length;
        graph.send({
            type: "addResolved",
            version: "elf1",
            requestId: staleAdd.requestId,
            requestedName: staleAdd.name,
            symbol: symbols[0]
        });
        assert.strictEqual(graph.messages.filter((m) => m.type === "saveWatch").length, savedCount);
        type("g_sameNameCounter");
        const reloading = submit();
        graph.send({ type: "variablesListReset", version: "elf2" });
        reply(reloading);
        assert.strictEqual(input.getAttribute("aria-expanded"), "false");
        // Real parser errors remain visible.
        graph.send({ type: "variablesListDone", version: "elf2", warnings: ["DWARF_BUDGET_EXCEEDED: test"] });
        assert(!graph.document.getElementById("importDiagnostics").hidden);
        graph.assertHealthy();
        sidebar.assertHealthy();
    } finally {
        graph.close();
        sidebar.close();
    }
}

(async () => {
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    const result = { symbols, elf: { sha256: "elf1" } };
    provider._elfService = { ready: async () => result, cache: result, generation: 1 };
    const messages = [];
    const post = (message) => messages.push(message);
    await provider._resolveLiveVariable({ name: "g_sameNameCounter", version: "elf1", requestId: 1 }, post);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, "variableChoices");
    assert.strictEqual(messages[0].requestId, 1);
    assert.strictEqual(messages[0].candidates[1].displayName, symbols[1].displayName);
    messages.length = 0;
    await provider._resolveLiveVariable({ name: symbols[0].displayName, version: "old", requestId: 2 }, post);
    assert.strictEqual(messages.length, 0, "old ELF requests cannot select a current symbol");
    await provider._resolveLiveVariable({ name: symbols[1].displayName, version: "elf1", requestId: 3 }, post);
    assert.strictEqual(messages[0].type, "addResolved");
    assert.strictEqual(messages[0].symbol.name, symbols[1].name);
    messages.length = 0;
    result.symbols = [{ ...symbols[0], addressAmbiguous: true }];
    await provider._resolveLiveVariable({ name: symbols[0].name, version: "elf1", requestId: 4 }, post);
    assert.strictEqual(messages[0].type, "liveError", "an unusable canonical identity cannot bypass the resolver");
    assert.strictEqual(messages[0].key, "live.varIdentityAmbiguous");
    assert(!messages[0].params.name.includes("_ZN"));
    messages.length = 0;
    const composite = { ...symbols[0], isComposite: true };
    result.symbols = [composite];
    provider._elfService.layout = async () => {
        provider._elfService.generation++;
    };
    await provider._resolveLiveVariable({ name: composite.name, version: "elf1", requestId: 5 }, post);
    assert.strictEqual(messages.length, 0, "ELF invalidation during layout resolution cannot add an old variable");

    provider.readElfSymbols = () => ({ symbols });
    provider._livePanels = new Map();
    provider._context = { workspaceState: { get: () => [] } };
    provider._latestSidebarSamples = new Map();
    provider._watchLists = {
        rebind: async () => {
            provider._watchNameChanges.ambiguous.set(
                raw,
                symbols.map((symbol) => symbol.name)
            );
            return new Map();
        }
    };
    provider._postLive = post;
    await provider._rebindWatchLists(symbols);
    const warning = messages.at(-1);
    assert.strictEqual(warning.key, "lw.watchAmbiguous");
    assert.strictEqual(warning.params.names, "g_sameNameCounter");
    assert(!warning.params.candidates.includes("_ZN"));
    console.log(
        "Source-qualified variable lists, inline choices, readable diagnostics and stale request guards passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
