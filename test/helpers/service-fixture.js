"use strict";
const fs = require("fs"),
    os = require("os"),
    path = require("path");
const { ConfigurationStore } = require("../../src/services/configurationStore");
function createFixture() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-service-"));
    const elf = path.join(temp, "firmware.elf");
    fs.writeFileSync(elf, "elf");
    const state = new Map();
    const settings = new Map();
    const cacheKeys = { elfPath: "elf", debugger: "debugger", mcuCore: "mcu", svdPath: "svd" };
    const context = {
        workspaceState: {
            get: (key) => state.get(key),
            update: async (key, value) => state.set(key, value)
        }
    };
    let changed = 0;
    const vscode = {
        ConfigurationTarget: { Workspace: 2 },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: temp } }],
            getConfiguration: () => ({
                get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
                update: async (key, value) => settings.set(key, value)
            })
        }
    };
    const store = new ConfigurationStore({
        vscode,
        context,
        cacheKeys,
        cleanPath: (value) => value.replace(/\\/g, "/"),
        isSafeCfg: (value) => typeof value === "string" && value.endsWith(".cfg") && !value.includes(".."),
        onChanged: () => {
            changed++;
        }
    });
    return {
        temp,
        elf,
        state,
        settings,
        cacheKeys,
        context,
        vscode,
        store,
        get changed() {
            return changed;
        },
        dispose() {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    };
}
module.exports = { createFixture };
