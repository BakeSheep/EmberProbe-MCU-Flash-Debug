"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryAnalysisController } = require("../src/services/memoryAnalysisController");
const { loadProvider } = require("./helpers/load-provider");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { getModernWebviewContent } = require("../src/modernView");
const { render } = require("./helpers/render-webview");
const { buildMemoryElf, snapshot, memoryMap, h750Regions } = require("./helpers/memory-fixture");
const { args } = require("../skills/mcu-elf-analyze/scripts/analyze-elf");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-memory-sidebar-"));
    const controllers = [];
    let dom;
    try {
        const elf = path.join(temp, "h750.elf");
        const buf = buildMemoryElf([
            { name: ".text", addr: 0x08000000, size: 67052, type: 1, flags: 6 },
            { name: ".bss", addr: 0x20000000, size: 55248, type: 8, flags: 3 }
        ]);
        fs.writeFileSync(elf, buf);
        const data = snapshot(buf, elf);
        const map = elf.replace(/\.elf$/, ".map");
        fs.writeFileSync(map, memoryMap(h750Regions, data.memory.sections));
        const posted = [],
            watchers = [],
            state = new Map();
        let invalidations = 0;
        const context = {
            workspaceState: {
                get: (key, fallback) => state.get(key) || fallback,
                update: async (key, value) => state.set(key, value)
            }
        };
        const vscode = {
            Uri: { file: (file) => ({ fsPath: file }) },
            RelativePattern: class {
                constructor(base, pattern) {
                    this.base = base;
                    this.pattern = pattern;
                }
            },
            workspace: {
                workspaceFolders: [{ uri: { fsPath: temp } }],
                getConfiguration: () => ({ get: (_key, fallback) => fallback }),
                findFiles: async () => [],
                onDidChangeConfiguration: () => ({ dispose() {} }),
                createFileSystemWatcher: (pattern) => {
                    const callbacks = {};
                    const watcher = {
                        pattern,
                        callbacks,
                        disposed: false,
                        onDidChange: (fn) => {
                            callbacks.change = fn;
                        },
                        onDidCreate: (fn) => {
                            callbacks.create = fn;
                        },
                        onDidDelete: (fn) => {
                            callbacks.delete = fn;
                        },
                        dispose() {
                            this.disposed = true;
                        }
                    };
                    watchers.push(watcher);
                    return watcher;
                }
            },
            window: { showOpenDialog: async () => [{ fsPath: map }] }
        };
        const elfService = {
            load: async () => data,
            invalidate: () => {
                invalidations++;
            }
        };
        const controller = new MemoryAnalysisController({ vscode, context, elfService, post: (m) => posted.push(m) });
        controllers.push(controller);
        await controller.refresh();
        const sidebar = posted.at(-1).result;
        const Provider = loadProvider(vscode);
        const provider = Object.create(Provider.prototype);
        provider._memoryAnalysisController = controller;
        const agent = await createAgentRoutes(provider)["elf.analyze"]({});
        assert.deepStrictEqual(agent.regions, sidebar.regions, "Agent and sidebar use exactly the same region data");
        assert.deepStrictEqual(agent.flash, sidebar.flash);
        assert.deepStrictEqual(agent.ram, sidebar.ram);
        await controller.selectSource();
        assert.strictEqual(state.get("memoryAnalysis.sources")[elf].mapFile, map);
        const noSelection = new MemoryAnalysisController({
            vscode: { ...vscode, window: { showOpenDialog: async () => undefined } },
            context,
            elfService,
            post() {}
        });
        controllers.push(noSelection);
        assert.strictEqual(await noSelection.selectSource(), undefined);
        const activeWatchers = watchers.filter((w) => !w.disposed);
        activeWatchers[0].callbacks.change();
        activeWatchers[0].callbacks.create();
        activeWatchers[0].callbacks.delete();
        assert.strictEqual(invalidations, 3);
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.strictEqual(posted.at(-1).state, "ready");
        let resolveOld;
        const stale = new MemoryAnalysisController({
            vscode,
            context,
            elfService: {
                load: () =>
                    new Promise((resolve) => {
                        resolveOld = resolve;
                    })
            },
            post: (m) => posted.push(m)
        });
        controllers.push(stale);
        const oldRequest = stale.refresh();
        stale.options.elfService.load = async () => data;
        stale.service.elfService.load = async () => data;
        await stale.refresh();
        const latest = posted.at(-1);
        resolveOld(data);
        await oldRequest;
        assert.strictEqual(posted.at(-1), latest, "old refresh cannot replace the new ELF result");
        const failing = new MemoryAnalysisController({
            vscode,
            context,
            elfService: {
                load: async () => {
                    throw Object.assign(new Error("No ELF"), { code: "ELF_NOT_CONFIGURED" });
                }
            },
            post: (m) => posted.push(m)
        });
        controllers.push(failing);
        await failing.refresh();
        assert.strictEqual(posted.at(-1).key, "memory.selectElf");
        dom = render(getModernWebviewContent({}, "zh"), { sections: { memoryAnalysisSection: false } });
        const section = dom.document.getElementById("memoryAnalysisSection");
        assert.strictEqual(section.open, false);
        const card = dom.document.getElementById("flashDebugSection");
        assert.deepStrictEqual(
            [...card.children].map((child) => child.className),
            ["primary-actions", "foot", "memory-inline"]
        );
        assert.strictEqual(card.querySelector(".foot #statusText")?.id, "statusText");
        const refresh = dom.document.getElementById("memoryRefresh");
        assert.strictEqual(refresh.closest("summary"), section.querySelector("summary"));
        assert.strictEqual(dom.window.getComputedStyle(refresh).borderRadius, "4px");
        for (const id of ["watchCount", "writeCount", "allCount"]) {
            const style = dom.window.getComputedStyle(dom.document.getElementById(id));
            assert.strictEqual(style.borderRadius, "4px");
        }
        dom.send({ type: "memoryAnalysis", state: "loading", requestId: 5 });
        assert.strictEqual(dom.document.getElementById("memoryRefresh").disabled, true);
        dom.send({ type: "memoryAnalysis", state: "ready", requestId: 5, result: sidebar });
        const body = dom.document.getElementById("memoryBody");
        assert.strictEqual(body.querySelectorAll(".memory-region").length, 6);
        assert.ok(body.textContent.includes("42.15%"));
        assert.ok(body.textContent.includes("51.16%"));
        assert.ok(body.textContent.includes("0.00%"));
        const summary = body.querySelector(".memory-summary");
        const details = body.querySelector("details");
        details.open = true;
        details.dispatchEvent(new dom.window.Event("toggle"));
        dom.send({ type: "memoryAnalysis", state: "loading", requestId: 5 });
        assert.strictEqual(body.querySelector(".memory-summary"), summary, "refresh retains completed content nodes");
        assert.strictEqual(body.querySelector("details"), details, "refresh retains expanded details");
        assert.strictEqual(details.open, true);
        assert.strictEqual(body.getAttribute("aria-busy"), "true");
        assert.ok(body.querySelector('[role="status"]').textContent.includes("正在加载"));
        dom.send({ type: "setLang", lang: "en" });
        assert.ok(body.textContent.includes("Section details"), "retained results follow language changes");
        assert.ok(body.querySelector('[role="status"]').textContent.includes("Loading"));
        dom.send({ type: "memoryAnalysis", state: "ready", requestId: 5, result: sidebar });
        assert.strictEqual(body.querySelector(".memory-refresh-status"), null);
        assert.strictEqual(body.getAttribute("aria-busy"), "false");
        assert.strictEqual(body.querySelector("details").open, true);
        assert.strictEqual(dom.document.getElementById("memoryRefresh").disabled, false);
        dom.send({ type: "memoryAnalysis", state: "error", requestId: 4, message: "old" });
        assert.strictEqual(body.querySelectorAll(".memory-region").length, 6);
        dom.document.getElementById("memoryRefresh").click();
        assert.strictEqual(dom.messages.at(-1).type, "memoryRefresh");
        assert.strictEqual(section.open, false, "refresh does not toggle the memory section");
        section.open = true;
        refresh.click();
        assert.strictEqual(section.open, true, "refresh keeps an expanded memory section open");
        dom.document.getElementById("memorySelectSource").click();
        assert.strictEqual(dom.messages.at(-1).type, "memorySelectSource");
        dom.send({ type: "setLang", lang: "en" });
        assert.ok(body.textContent.includes("Section details"));
        const unsafe = structuredClone(sidebar);
        unsafe.regions[0].name = '<img src=x onerror="bad()">';
        dom.send({ type: "memoryAnalysis", state: "ready", requestId: 6, result: unsafe });
        assert.strictEqual(body.querySelector("img"), null);
        dom.send({
            type: "memoryAnalysis",
            state: "error",
            requestId: 7,
            code: "ELF_NOT_CONFIGURED",
            key: "memory.selectElf"
        });
        assert.ok(body.textContent.includes("Select an ELF"));
        dom.send({ type: "memoryAnalysis", state: "loading", requestId: 8 });
        assert.strictEqual(body.querySelector(".memory-summary"), null, "missing ELF clears the retained result");
        assert.ok(body.textContent.includes("Loading"));
        assert.deepStrictEqual(args(["--map", "app.map", "--linker-script", "chip.ld", "--top", "30"]), {
            map: "app.map",
            "linker-script": "chip.ld",
            top: "30"
        });
        assert.throws(() => args(["--map"]), /Missing/);
        assert.throws(() => args(["--unknown", "x"]), /Unknown/);
        dom.assertHealthy();
        controller.dispose();
        assert.ok(controller.watchers.length === 0);
        const count = posted.length;
        await controller.refresh();
        assert.strictEqual(posted.length, count);
    } finally {
        dom?.close();
        for (const controller of controllers) controller.dispose();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log("Memory sidebar, Agent parity, source selection and refresh isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
