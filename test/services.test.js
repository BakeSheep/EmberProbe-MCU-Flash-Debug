"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ConfigurationStore } = require("../src/services/configurationStore");
const { FlashService } = require("../src/services/flashService");
const { FaultService } = require("../src/services/faultService");
const { AgentService } = require("../src/services/agentService");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-services-"));
    try {
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
        const snapshot = await store.update({
            elf: "firmware.elf",
            debugger: "cmsis-dap.cfg",
            mcu: "stm32f4x.cfg",
            sampleIntervalMs: 50
        });
        assert.ok(snapshot.elf.endsWith("/firmware.elf"));
        assert.strictEqual(snapshot.debugger, "cmsis-dap.cfg");
        assert.strictEqual(snapshot.sampleIntervalMs, 50);
        assert.strictEqual(changed, 1);
        await assert.rejects(
            () => store.update({ sampleIntervalMs: 1 }),
            (error) => error.code === "INVALID_CONFIG_VALUE"
        );

        let flashOptions;
        const flash = new FlashService({
            runOpenOcd: async (_vscode, options, progress) => {
                flashOptions = options;
                progress({ stage: "done" });
                return { ok: true };
            }
        });
        const progress = [];
        assert.deepStrictEqual(await flash.download({}, { elf }, (event) => progress.push(event)), { ok: true });
        assert.strictEqual(flashOptions.elf, elf);
        assert.deepStrictEqual(progress, [{ stage: "done" }]);

        const fault = new FaultService(
            {
                readFaultInfo: async () => ({
                    values: { cfsr: 1 },
                    targetState: "halted",
                    registers: {},
                    pc: "0x08000104",
                    lr: "0x08000200",
                    sp: "0x20001000",
                    xpsr: "0x01000000"
                }),
                decodeFaultRegisters: () => ({ faultDetected: true, faults: ["IACCVIOL"], exception: "HardFault" })
            },
            {
                nearestFunction: (_functions, address) => (address === 0x08000104 ? { name: "main", offset: 4 } : null)
            }
        );
        const faultResult = await fault.read({}, () => [{ name: "main" }]);
        assert.strictEqual(faultResult.pcSymbol, "main+0x4");
        assert.strictEqual(faultResult.faultDetected, true);

        class FakeBridge {
            constructor(workspace, handler) {
                this.workspace = workspace;
                this.handler = handler;
                this.stopped = false;
            }
            async start() {
                return { workspace: this.workspace };
            }
            async stop() {
                this.stopped = true;
            }
        }
        const agent = new AgentService({
            Bridge: FakeBridge,
            workspaceProvider: () => temp,
            handlers: {
                "config.get": async () => ({ ok: true }),
                "chip.read": async () => ({ core: "Cortex-M4", pc: "0x1", secret: "hidden" })
            }
        });
        assert.deepStrictEqual(await agent.call("config.get"), { ok: true });
        assert.deepStrictEqual(await agent.call("chip.read", { sections: ["runtime"] }), { pc: "0x1" });
        const capabilities = await agent.call("capabilities");
        assert.deepStrictEqual(capabilities.methods, ["config.get", "chip.read"]);
        await assert.rejects(
            () => agent.call("missing"),
            (error) => error.code === "METHOD_NOT_FOUND"
        );
        assert.deepStrictEqual(await agent.start(), { workspace: temp });
        const bridge = agent.bridge;
        await agent.stop();
        assert.strictEqual(bridge.stopped, true);

        console.log("Service boundary tests passed");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
