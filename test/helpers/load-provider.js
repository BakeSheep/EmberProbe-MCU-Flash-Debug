"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");
// Load the complete CommonJS module with only the VS Code host dependency replaced.
// No source extraction or regex assertions: tests execute production methods. The source is compiled unchanged under
// its file URL, as Node compiles modules, so coverage maps back to src/mainViewProvider.js.
function loadProvider(vscode = {}, overrides = {}) {
    const filename = path.resolve(__dirname, "../../src/mainViewProvider.js");
    const localRequire = createRequire(filename);
    const exports = {};
    const run = vm.compileFunction(
        fs.readFileSync(filename, "utf8"),
        ["require", "module", "exports", "__dirname", "__filename"],
        { filename: pathToFileURL(filename).href }
    );
    run(
        (name) => (name === "vscode" ? vscode : Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name)),
        { exports },
        exports,
        path.dirname(filename),
        filename
    );
    return exports.MainViewProvider;
}

function memento() {
    const values = new Map();
    return {
        values,
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        },
        keys: () => [...values.keys()]
    };
}

// A provider built by its real constructor, with a minimal VS Code API (settings read their defaults) and an extension
// context whose global storage and workspace folder are a new temporary directory. `vscode` entries replace the fake's
// top-level namespaces. dispose() shuts the provider down and removes the directory.
function createProvider({ vscode: namespaces = {}, overrides = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-provider-"));
    const settings = { get: (_key, fallback) => fallback, update: async () => {} };
    const vscode = {
        env: { language: "en", appName: "Test" },
        Uri: {
            file: (fsPath) => ({ fsPath }),
            joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) })
        },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => settings },
        window: {},
        debug: {},
        ...namespaces
    };
    const context = {
        extensionPath: path.resolve(__dirname, "../.."),
        globalStorageUri: { fsPath: path.join(root, "storage") },
        workspaceState: memento(),
        globalState: memento(),
        extension: { packageJSON: { version: "0.0.0-test" } },
        subscriptions: []
    };
    fs.mkdirSync(context.globalStorageUri.fsPath);
    const Provider = loadProvider(vscode, overrides);
    const provider = new Provider(context);
    return {
        provider,
        vscode,
        context,
        root,
        async dispose() {
            await provider.shutdown();
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}
module.exports = { loadProvider, createProvider };
