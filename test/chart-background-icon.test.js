"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const Icon = require("../src/webview/liveWatch/backgroundIcon");
const Controller = require("../src/webview/liveWatch/backgroundIconController");
const { ChartBackgroundController: NativeController } = require("../src/services/chartBackgroundController");
const { ChartBackgroundStore } = require("../src/services/chartBackgroundStore");
const { loadProvider } = require("./helpers/load-provider");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { render } = require("./helpers/render-webview");
const { paint } = require("../src/webview/liveWatch/chart");
const VP = require("../src/webview/liveWatch/viewport");

function image(w, h, color = [255, 255, 255, 255]) {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set(color, i * 4);
    return {
        rgba,
        pixel(x, y, c) {
            rgba.set(c, (y * w + x) * 4);
        }
    };
}
function alpha(icon) {
    return Array.from(Buffer.from(icon.alphaBase64, "base64"));
}
function header(w, h) {
    const bytes = Buffer.alloc(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    bytes.writeUInt32BE(w, 16);
    bytes.writeUInt32BE(h, 20);
    return bytes;
}
const sample = { version: 1, width: 2, height: 1, alphaBase64: "/4A=" };

async function extraction() {
    const transparent = image(5, 5, [100, 80, 70, 0]);
    transparent.pixel(1, 1, [255, 0, 0, 255]);
    transparent.pixel(2, 1, [0, 255, 0, 128]);
    transparent.pixel(3, 3, [0, 0, 255, 255]);
    const icon = Icon.extract(5, 5, transparent.rgba);
    assert.equal(icon.width, 3);
    assert.equal(icon.height, 3);
    assert.deepStrictEqual(alpha(icon), [255, 128, 0, 0, 0, 0, 0, 0, 255]);
    for (const color of [
        [255, 255, 255, 255],
        [20, 60, 100, 255]
    ]) {
        const opaque = image(7, 7, color);
        opaque.pixel(3, 3, [200, 0, 0, 255]);
        opaque.pixel(3, 2, [color[0] - 20, color[1], color[2], 255]);
        const shape = Icon.extract(7, 7, opaque.rgba);
        assert.equal(shape.width, 1);
        assert.equal(shape.height, 2);
        assert.deepStrictEqual(alpha(shape), [32, 255], "soft edge coverage survives recoloring");
    }
    const ring = image(7, 7);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) if (x !== 3 || y !== 3) ring.pixel(x, y, [0, 0, 0, 255]);
    assert.deepStrictEqual(
        alpha(Icon.extract(7, 7, ring.rgba)),
        new Array(9).fill(255),
        "enclosed background is not reached by the boundary flood"
    );
    const large = image(1024, 2, [0, 0, 0, 128]);
    const small = Icon.extract(1024, 2, large.rgba);
    assert.equal(small.width, 512);
    assert.equal(small.height, 1);
    assert.ok(alpha(small).every((v) => v === 128));
    assert.throws(() => Icon.extract(2, 2, image(2, 2).rgba), /empty/);
    assert.throws(() => Icon.extract(2, 2, image(2, 2, [0, 0, 0, 0]).rgba), /empty/);
    const complex = image(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) complex.pixel(x, y, [((x + y) % 2) * 255, 0, 0, 255]);
    assert.throws(() => Icon.extract(4, 4, complex.rgba), /background/);
    assert.throws(() => Icon.extract(5000, 1, []), /size/);
    assert.throws(() => Icon.extract(2, 2, []), /size/);

    assert.deepStrictEqual(Icon.pngSize(header(4, 5)), { width: 4, height: 5 });
    for (const data of [Buffer.alloc(33), header(0, 1), Buffer.from("<svg/>"), header(2, 2).subarray(0, 20)])
        assert.throws(() => Icon.pngSize(data), /invalid/);
    for (const data of [header(4097, 1), header(4001, 4000)]) assert.throws(() => Icon.pngSize(data), /size/);
    for (const value of [
        undefined,
        {},
        { ...sample, version: 2 },
        { ...sample, width: 0 },
        { ...sample, width: 513 },
        { ...sample, height: 1.5 },
        { ...sample, alphaBase64: "/4B=" },
        { ...sample, alphaBase64: "AAAA" },
        { ...sample, alphaBase64: "AA==" },
        { ...sample, alphaBase64: "!!==" },
        { ...sample, alphaBase64: "AAA=" }
    ])
        assert.throws(() => Icon.validate(value));
    assert.deepStrictEqual(Icon.validate({ ...sample, sourcePath: "discard" }), sample);
    assert.equal(
        Icon.validate({
            version: 1,
            width: 512,
            height: 512,
            alphaBase64: Buffer.alloc(512 * 512, 255).toString("base64")
        }).width,
        512
    );
    await assert.rejects(Icon.importFile({ size: Icon.MAX_FILE_BYTES + 1 }), /size/);
    await assert.rejects(Icon.importFile(new Blob(["invalid"])), /invalid/);
    let closed = 0;
    const env = {
        async createImageBitmap() {
            return {
                width: 5,
                height: 5,
                close() {
                    closed++;
                }
            };
        },
        document: {
            createElement() {
                return {
                    getContext() {
                        return {
                            drawImage() {},
                            getImageData() {
                                return { data: transparent.rgba };
                            }
                        };
                    }
                };
            }
        }
    };
    assert.deepStrictEqual(await Icon.importFile(new Blob([header(5, 5)]), env), icon);
    assert.equal(closed, 1);
    await assert.rejects(Icon.importFile(new Blob([header(1, 1)]), env), /invalid/);
    assert.equal(closed, 2);
    await assert.rejects(
        Icon.importFile(new Blob([header(1, 1)]), {
            createImageBitmap: async () => {
                throw new Error("PNG checksum error");
            }
        }),
        /invalid/
    );
}

async function storageAndHost() {
    const values = new Map(),
        errors = [],
        entries = [];
    let fail = false,
        selected = [{}],
        enabled = true,
        fileBytes = header(5, 5),
        statSize = 33,
        dialogs = 0;
    const state = {
        get: (k) => values.get(k),
        update: async (k, v) => {
            if (fail) throw new Error("disk full");
            values.set(k, v);
        }
    };
    const store = new ChartBackgroundStore(state);
    assert.equal(store.read(), null);
    await store.update(sample);
    assert.deepStrictEqual(new ChartBackgroundStore(state).read(), sample);
    fail = true;
    await assert.rejects(store.update(null), /disk full/);
    assert.deepStrictEqual(store.read(), sample);
    fail = false;
    await store.update(null);
    assert.equal(store.read(), null);
    assert.throws(() => store.update({}), /invalid/);
    await assert.rejects(new ChartBackgroundStore().update(null), /unavailable/);
    const vscode = {
        ProgressLocation: { Notification: 15 },
        workspace: {
            getConfiguration: () => ({ get: () => enabled }),
            fs: { stat: async () => ({ size: statSize }), readFile: async () => fileBytes }
        },
        window: {
            showOpenDialog: async (options) => {
                dialogs++;
                assert.deepStrictEqual(options.filters, { PNG: ["png"] });
                assert.equal(options.canSelectMany, false);
                return selected;
            },
            showErrorMessage: (key) => errors.push(key),
            withProgress: async (_opts, task) => task()
        }
    };
    const controller = new NativeController({
        vscode,
        state,
        entries: () => entries,
        t: (k) => k,
        open() {
            entries.push({
                ready: false,
                focusOrder: 1,
                messages: [],
                post(m) {
                    this.messages.push(m);
                }
            });
        }
    });
    async function waitPending() {
        for (let i = 0; i < 20 && !controller.pending; i++) await new Promise(setImmediate);
        assert.ok(controller.pending);
        return controller.pending;
    }
    selected = undefined;
    await controller.select();
    assert.equal(entries.length, 0, "cancel opens no waveform");
    selected = [{}];
    const importing = controller.select();
    assert.strictEqual(controller.select(), importing, "duplicate commands share the current import");
    const pending = await waitPending(),
        entry = entries[0];
    assert.equal(entry.messages.length, 0, "new renderer must be ready before receiving the PNG");
    entry.ready = true;
    controller.ready(entry);
    controller.ready(entry);
    assert.equal(entry.messages.length, 1);
    assert.equal(entry.messages[0].type, "importChartBackgroundIcon");
    assert.equal(pending.pngBase64, null, "raw PNG is released after dispatch");
    await controller.imported({}, { requestId: pending.requestId, icon: sample });
    await controller.imported(entry, { requestId: pending.requestId - 1, icon: sample });
    assert.equal(store.read(), null, "foreign and stale replies cannot save a mask");
    await controller.imported(entry, { requestId: pending.requestId, icon: sample });
    await importing;
    assert.deepStrictEqual(store.read(), sample);
    assert.equal(entry.messages.at(-1).type, "chartBackgroundIcon");
    enabled = false;
    controller.broadcast();
    assert.equal(entry.messages.at(-1).icon, null);
    assert.deepStrictEqual(store.read(), sample, "hide keeps the mask");
    enabled = true;
    controller.broadcast();
    assert.deepStrictEqual(entry.messages.at(-1).icon, sample);
    for (const errorCode of ["background", "empty", "invalid", "size"]) {
        const task = controller.select(),
            job = await waitPending();
        await controller.imported(entry, { requestId: job.requestId, errorCode });
        await task;
        assert.deepStrictEqual(store.read(), sample, "processing failure preserves previous icon");
        assert.ok(errors.at(-1).endsWith("Error"));
    }
    const failedSave = controller.select(),
        saving = await waitPending();
    fail = true;
    await controller.imported(entry, { requestId: saving.requestId, icon: sample });
    await failedSave;
    assert.equal(errors.at(-1), "lw.backgroundSaveError");
    fail = false;
    const cancelled = controller.select(),
        stale = await waitPending();
    await controller.remove();
    await cancelled;
    await controller.imported(entry, { requestId: stale.requestId, icon: sample });
    assert.equal(store.read(), null, "remove fences late decode results");
    const closed = controller.select();
    await waitPending();
    controller.cancel({});
    assert.ok(controller.pending);
    controller.cancel(entry);
    await closed;
    const timed = controller.select();
    await waitPending();
    controller.cancel(undefined, "timeout");
    await timed;
    assert.equal(errors.at(-1), "lw.backgroundSaveError");
    statSize = Icon.MAX_FILE_BYTES + 1;
    await controller.select();
    assert.equal(errors.at(-1), "lw.backgroundSizeError");
    statSize = 33;
    fileBytes = Buffer.alloc(Icon.MAX_FILE_BYTES + 1);
    await controller.select();
    assert.equal(errors.at(-1), "lw.backgroundSizeError");
    fileBytes = Buffer.from("invalid");
    await controller.select();
    assert.equal(errors.at(-1), "lw.backgroundInvalidError");
    fail = true;
    await controller.remove();
    assert.equal(errors.at(-1), "lw.backgroundSaveError");
    fail = false;
    assert.ok(dialogs >= 10);
    fileBytes = header(5, 5);
    const originalPost = entry.post;
    for (const outcome of [
        () => false,
        () => Promise.reject(new Error("disposed")),
        () => {
            throw new Error("closed");
        }
    ]) {
        entry.post = outcome;
        await controller.select();
        assert.equal(controller.pending, null, "failed delivery releases its timer and import promise");
        assert.equal(errors.at(-1), "lw.backgroundInvalidError");
    }
    entry.post = originalPost;

    const panels = [],
        focus = [];
    const P = loadProvider({
        ViewColumn: { Active: 1 },
        workspace: { getConfiguration: () => ({}) },
        window: {
            onDidChangeWindowState(fn) {
                focus.push(fn);
                return { dispose() {} };
            },
            createWebviewPanel() {
                const p = {
                    messages: [],
                    webview: {
                        postMessage(m) {
                            p.messages.push(m);
                        },
                        onDidReceiveMessage(fn) {
                            p.receive = fn;
                        }
                    },
                    onDidChangeViewState(fn) {
                        p.activate = fn;
                    },
                    onDidDispose() {}
                };
                panels.push(p);
                return p;
            }
        }
    });
    const provider = Object.create(P.prototype);
    Object.assign(provider, {
        _context: { globalState: state, workspaceState: { keys: () => [], get: () => [], update: async () => {} } },
        _livePanels: new Map(),
        _livePanelFocusOrder: 0,
        _lang: "en",
        _t: (key) => key,
        _invalidateConsumerTypes() {},
        _renderWebview() {},
        _syncGraphTarget() {},
        _unlimitedSamplingState: () => ({}),
        _pointerSamplingState: () => ({}),
        _curveVisibility: () => ({})
    });
    provider.openLiveWatchPanel();
    provider.openLiveWatchPanel();
    await provider.chartBackground().store.update(sample);
    provider.chartBackground().broadcast();
    assert.deepStrictEqual(panels[0].messages.at(-1).icon, sample);
    assert.deepStrictEqual(panels[1].messages.at(-1).icon, sample);
    await panels[1].receive({ type: "ready" });
    assert.ok(panels[1].messages.some((m) => m.type === "chartBackgroundIcon" && m.icon));
    await panels[0].receive({ type: "chartBackgroundIconImported", requestId: 99, icon: null });
    assert.deepStrictEqual(
        provider._chartBackgroundState().icon,
        sample,
        "unsolicited renderer results cannot change global preference"
    );
    await provider.chartBackground().remove();
    assert.equal(provider._chartBackgroundState().icon, null);
    await store.update(sample);
    focus[0]({ focused: true });
    assert.deepStrictEqual(panels[0].messages.at(-1).icon, sample);
    panels[1].activate({ webviewPanel: { active: true } });
    assert.deepStrictEqual(panels[1].messages.at(-1).icon, sample);
    const setting =
        require("../package.json").contributes.configuration.properties["emberprobe.chartBackgroundIcon.enabled"];
    assert.equal(setting.scope, "application");
    assert.equal(setting.ignoreSync, true);
    assert.ok(setting.markdownDescription.includes("command:mcu-vscode.selectChartBackgroundIcon"));
}

async function controllerAndPainting() {
    const dom = new JSDOM("");
    const doc = dom.window.document,
        sent = [];
    let resolve,
        reject,
        changes = 0,
        imports = 0,
        tintCalls = 0;
    const controller = Controller.create({
        document: doc,
        post: (m) => sent.push(m),
        changed: () => changes++,
        importFile: () => {
            imports++;
            return new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            });
        }
    });
    const pngBase64 = header(5, 5).toString("base64");
    const first = controller.importPng({ requestId: 1, pngBase64 });
    const resolveFirst = resolve;
    await controller.importPng({ requestId: 1, pngBase64 });
    assert.equal(imports, 1);
    const second = controller.importPng({ requestId: 2, pngBase64 });
    resolve(sample);
    await second;
    resolveFirst(sample);
    await first;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].requestId, 2);
    // Complete an older decoder after a newer request; it cannot publish stale data.
    const older = Controller.create({
        document: doc,
        post: (m) => sent.push(m),
        changed() {},
        importFile: () => Promise.resolve(sample)
    });
    await older.importPng({ requestId: 1, pngBase64 });
    assert.equal(sent.at(-1).type, "chartBackgroundIconImported");
    controller.receive({ icon: sample });
    doc.createElement = () => ({
        getContext: () => ({
            createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
            putImageData(pixels) {
                assert.deepStrictEqual(Array.from(pixels.data), [0, 0, 0, 255, 0, 0, 0, 128]);
            },
            fillRect() {
                tintCalls++;
            }
        })
    });
    const gray = { getPropertyValue: () => " #aaa " },
        dark = { getPropertyValue: () => "#333" };
    const bitmap = controller.bitmap(gray);
    assert.strictEqual(controller.bitmap(gray), bitmap);
    assert.equal(tintCalls, 1);
    assert.notStrictEqual(controller.bitmap(dark), bitmap);
    assert.equal(tintCalls, 2);
    let id = 2;
    for (const code of ["size", "background", "empty", "invalid", "other"]) {
        const p = controller.importPng({ requestId: ++id, pngBase64 });
        reject({ code });
        await p;
        assert.equal(sent.at(-1).errorCode, code === "other" ? "invalid" : code);
    }
    await controller.importPng({ requestId: ++id, pngBase64: null });
    assert.equal(sent.at(-1).errorCode, "size");
    await controller.importPng({ requestId: ++id, pngBase64: "!!!" });
    assert.equal(sent.at(-1).errorCode, "invalid");
    controller.receive({ icon: null });
    assert.equal(controller.bitmap(gray), null);
    controller.receive({ icon: {} });
    assert.equal(controller.bitmap(gray), null);
    assert.equal(changes, 2);
    dom.window.close();
    const view = render(getLiveWatchContent({}, "zh"));
    view.send({ type: "chartBackgroundIcon", icon: null });
    assert.equal(view.document.getElementById("backgroundIconUpload"), null);
    assert.equal(view.document.getElementById("backgroundIconFile"), null);
    view.assertHealthy();
    view.close();

    const calls = [],
        ctx = new Proxy(
            {},
            {
                get: (o, k) =>
                    o[k] || (k === "measureText" ? () => ({ width: 40 }) : (...args) => calls.push([k, ...args]))
            }
        );
    const elements = { chartEmpty: { classList: { remove() {}, add() {} } }, points: {}, range: {} };
    const options = {
        canvas: { clientWidth: 600, clientHeight: 300 },
        ctx,
        chartState: { x: { min: 0, max: 10 }, autoY: true },
        norm: false,
        backgroundIcon: { width: 2, height: 1 },
        series: [],
        hasBounds: false,
        pixelRatio: 2,
        style: { getPropertyValue: () => "#999" },
        elements,
        VP,
        t: (key) => key,
        fmtNum: String,
        colorFor: () => "red",
        formatChartTime: String,
        padRange: (min, max) => ({ min: min - 1, max: max + 1 })
    };
    paint(options);
    const draw = calls.find((c) => c[0] === "drawImage");
    assert.equal(draw[4], 288);
    assert.equal(draw[5], 144);
    assert.equal(draw[2] + draw[4] / 2, 64 + (600 - 82) / 2);
    assert.equal(draw[3] + draw[5] / 2, 18 + (300 - 60) / 2);
    calls.length = 0;
    paint({
        ...options,
        hasBounds: true,
        series: [
            {
                item: { name: "v" },
                idx: 0,
                arr: [
                    { t: 0, v: 1 },
                    { t: 10, v: 2 }
                ]
            }
        ]
    });
    assert.ok(
        calls.findIndex((c) => c[0] === "drawImage") < calls.findIndex((c) => c[0] === "stroke"),
        "icon is painted before grid and curves"
    );
}

(async () => {
    await extraction();
    await storageAndHost();
    await controllerAndPainting();
    console.log("Chart background icon extraction, storage, routing and rendering tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
