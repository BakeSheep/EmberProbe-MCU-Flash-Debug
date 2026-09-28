"use strict";
const assert = require("assert");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { AgentService } = require("../src/services/agentService");

(async () => {
    const calls = [];
    let operation = "op-1";
    function stub(prefix = "") {
        return new Proxy(() => {}, {
            get: (_target, key) => stub(prefix ? `${prefix}.${String(key)}` : String(key)),
            apply: (_target, _receiver, args) => {
                calls.push({ method: prefix, args });
                return prefix === "_cubemxService.check" ? { operationId: operation } : { method: prefix };
            }
        });
    }
    const routes = createAgentRoutes(stub(), () => ({ devices: ["probe"] }));
    const bridge = new AgentService({ handlers: routes });
    const expected = {
        "config.get": "_configurationSnapshot",
        "config.set": "_setAgentConfiguration",
        "cubemx.detect": "_cubemxConfiguration.detect",
        "cubemx.inspect": "_cubemxService.inspect",
        "cubemx.prepare": "_cubemxService.prepare",
        "cubemx.candidate": "_cubemxService.generateCandidate",
        "cubemx.start": "_startAgentCubeMxOperation",
        "cubemx.status": "_cubemxService.status",
        "cubemx.execute": "_executeAgentCubeMx",
        "cubemx.permission": "_cubemxService.permission",
        "cubemx.cancel": "_cubemxService.cancel",
        "flash.authorize": "_agentFlashService.authorize",
        "flash.execute": "_agentFlashService.execute",
        "flash.verify": "_agentFlashService.execute",
        "watch.add": "_addAgentWatch",
        "variables.exportCsv": "_exportAgentCsv",
        "variables.read": "_readAgentVariables",
        "variables.sample": "_sampleAgentVariables",
        "sampling.status": "_controlAgentSampling",
        "sampling.start": "_controlAgentSampling",
        "sampling.stop": "_controlAgentSampling",
        "variables.write": "_writeAgentVariables",
        "variables.write.permission": "_agentWritePermission",
        "fault.read": "_readAgentFault",
        "elf.analyze": "_analyzeElf",
        "peripherals.list": "_svdPeripheralService.list",
        "peripherals.read": "_svdPeripheralService.read",
        "peripherals.write": "_svdPeripheralService.write",
        "debug.status": "_debugControlService.status",
        "debug.start": "_debugControlService.start",
        "debug.control": "_debugControlService.control",
        "debug.breakpoints.list": "_debugControlService.listBreakpoints",
        "debug.breakpoints.update": "_debugControlService.updateBreakpoints"
    };
    for (const [method, target] of Object.entries(expected)) {
        calls.length = 0;
        await bridge.call(method, { values: { elf: "test.elf" }, marker: "request" });
        assert.strictEqual(calls.at(-1).method, target, method);
        if (method === "flash.verify") assert.strictEqual(calls.at(-1).args[1], true);
        if (method === "flash.execute") assert.strictEqual(calls.at(-1).args.length, 1);
        if (method === "config.set") assert.deepStrictEqual(calls.at(-1).args[0], { elf: "test.elf" });
        if (method.startsWith("sampling.")) assert.strictEqual(calls.at(-1).args[0], method.split(".")[1]);
        if (method === "peripherals.write") assert.strictEqual(calls[0].method, "_assertWriteSessionCurrent");
        await bridge.call(method);
        if (method !== "config.set") await routes[method](null);
    }
    assert.deepStrictEqual(await bridge.call("probe.list"), { devices: ["probe"] });
    await routes["chip.read"]();
    assert.deepStrictEqual(calls.at(-1).args, [true]);
    await bridge.call("cubemx.check");
    assert.strictEqual(calls.at(-1).method, "_showAgentCubeMxProgress");
    operation = null;
    await routes["cubemx.check"]();
    assert.strictEqual(calls.at(-1).method, "_cubemxService.check");
    assert.deepStrictEqual(
        new Set(bridge.methods()),
        new Set([...Object.keys(expected), "probe.list", "chip.read", "cubemx.check"])
    );
    const failure = new Error("stale session");
    const guarded = createAgentRoutes({
        _assertWriteSessionCurrent() {
            throw failure;
        }
    });
    assert.throws(
        () => guarded["peripherals.write"]({}),
        (error) => error === failure
    );
    console.log("Agent route dispatch and peripheral write guards passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
