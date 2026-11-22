"use strict";

const { performance } = require("node:perf_hooks");
const { createWorkerElfService } = require("../helpers/elf-service");
const { render } = require("../helpers/render-webview");
const { waitFor } = require("../helpers/wait");
const { getModernWebviewContent } = require("../../src/modernView");
const { getLiveWatchContent } = require("../../src/liveWatchView");
const runtime = require("../../src/webview/runtime");

function measure(action) {
    const start = performance.now();
    action();
    return performance.now() - start;
}

function median(action) {
    action(0);
    return Array.from({ length: 7 }, (_, index) => measure(() => action(index + 1))).sort((a, b) => a - b)[3];
}

async function benchmark(file, sidebar) {
    const service = createWorkerElfService(file);
    let page,
        completed = 0;
    const pending = new Set();
    try {
        const start = performance.now();
        const elf = await service.ready();
        const readyMs = performance.now() - start;
        const version = elf.elf.sha256;
        const generation = service.generation;
        const prefix = sidebar ? "availableVariables" : "variablesList";
        const candidates = elf.symbols.filter((symbol) => symbol.isComposite || symbol.isReference);
        const layouts = new Map();
        async function reply(message) {
            let layout, error;
            try {
                layout = await service.layout(message.name, {
                    generation,
                    background: message.background === true && message.promote !== true
                });
            } catch (failure) {
                error = failure.message;
            }
            if (layout) layouts.set(message.name, layout);
            if (message.promote !== true) {
                page.send({
                    type: "compositeLayoutResult",
                    name: message.name,
                    version,
                    generation,
                    layout: structuredClone(layout),
                    error
                });
                completed++;
            }
        }
        page = render(
            sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"),
            {},
            {
                beforeParse(window) {
                    const acquire = window.acquireVsCodeApi;
                    window.acquireVsCodeApi = () => {
                        const api = acquire();
                        return {
                            ...api,
                            postMessage(message) {
                                if (message.type !== "resolveCompositeLayout") return api.postMessage(message);
                                const task = reply(message).finally(() => pending.delete(task));
                                pending.add(task);
                            }
                        };
                    };
                }
            }
        );
        const { document, window } = page;
        page.send({ type: prefix + "Reset", version, generation });
        page.send({ type: prefix + "Chunk", version, symbols: structuredClone(elf.symbols) });
        if (!sidebar) document.getElementById("import").click();
        page.send({ type: prefix + "Done", version });
        page.send({ type: sidebar ? "availableTypesDone" : "variableTypesDone", version });
        const filter = document.getElementById(sidebar ? "varSearch" : "impFilter");
        const list = document.getElementById(sidebar ? "availableVars" : "impList");
        function search(query) {
            filter.value = query;
            filter.dispatchEvent(new window.Event("input", { bubbles: true }));
        }
        const coldStart = performance.now();
        search("emberprobe_benchmark_absent");
        await waitFor(
            () => !pending.size && list.querySelector(".empty")?.textContent === window.__I18N__.en["sb.noMatch"],
            "member search finishes",
            60000
        );
        const coldSearchMs = performance.now() - coldStart;
        const warmMissMs = median((index) => search("emberprobe_benchmark_absent_" + index));
        const broadQueryMs = median((index) => search(index % 2 ? "" : "_"));
        search("");

        const large = candidates
            .filter((symbol) => layouts.has(symbol.name) && !layouts.get(symbol.name).runtimeLayout)
            .map((symbol) => {
                const layout = layouts.get(symbol.name);
                const leaves = runtime.displayLayoutLeaves(symbol, layout, symbol.name, symbol.address).length;
                return { symbol, layout, leaves };
            })
            .sort((a, b) => b.leaves - a.leaves)[0];
        if (!large) throw new Error(`No static composite symbol resolved in ${file}`);
        let row = [...list.querySelectorAll("[data-picker-path]")].find(
            (element) => element.dataset.pickerPath === large.symbol.name
        );
        const filtered = !row;
        if (filtered) {
            search(large.symbol.name);
            row = [...list.querySelectorAll("[data-picker-path]")].find(
                (element) => element.dataset.pickerPath === large.symbol.name
            );
        }
        const expandMs = measure(() => row.querySelector("button[aria-expanded]").click());
        const visiblePickerMembers = row.nextElementSibling.querySelectorAll("[data-picker-member]").length;
        if (filtered) search("");
        if (!sidebar) document.getElementById("impCancel").click();

        const watchType = sidebar ? "sidebarWatchList" : "watchList";
        const item = { ...large.symbol, compositeLayout: large.layout, type: "" };
        const foldedWatchMs = median(() => page.send({ type: watchType, items: [structuredClone(item)] }));
        const watchBox = document.getElementById(sidebar ? "liveValues" : "vars");
        const countMembers = () => watchBox.querySelectorAll(sidebar ? ".sb-mrow" : ".member-row").length;
        const foldedWatchMembers = countMembers();
        const headSelector = sidebar ? ".sb-comp-head" : ".comp-head";
        const watchHead = watchBox.querySelector(headSelector);
        const openWatchMs = measure(() => watchHead.click());
        const openWatchMembers = countMembers();
        let branch = watchHead.nextElementSibling;
        const openBranchMs = measure(() => {
            let head;
            while ((head = branch?.querySelector(headSelector))) {
                head.click();
                branch = head.nextElementSibling;
            }
        });
        const openBranchMembers = countMembers();
        const milliseconds = {
            readyMs,
            coldSearchMs,
            warmMissMs,
            broadQueryMs,
            expandMs,
            foldedWatchMs,
            openWatchMs,
            openBranchMs
        };
        return {
            sha256: version,
            view: sidebar ? "sidebar" : "import",
            symbols: elf.symbols.length,
            layoutRequests: completed,
            largeSymbol: large.symbol.name,
            searchableMembers: large.leaves,
            visiblePickerMembers,
            foldedWatchMembers,
            openWatchMembers,
            openBranchMembers,
            ...Object.fromEntries(Object.entries(milliseconds).map(([key, ms]) => [key, Number(ms.toFixed(1))]))
        };
    } finally {
        await Promise.allSettled(pending);
        page?.close();
        service.invalidate();
    }
}

(async () => {
    const file = process.argv[2];
    if (!file) throw new Error("Usage: node test/perf/variable-picker-bench.js <file.elf>");
    for (const sidebar of [true, false]) console.log(JSON.stringify(await benchmark(file, sidebar)));
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
