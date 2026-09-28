"use strict";
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");

function createAgentRoutes(host, probes = listProbes) {
    const listProbes = probes;
    return {
        "config.get": () => host._configurationSnapshot(),
        "probe.list": () => listProbes(),
        "config.set": (params) => host._setAgentConfiguration(params.values || {}),
        "cubemx.detect": () => host._cubemxConfiguration.detect(),
        "cubemx.inspect": (params) => host._cubemxService.inspect(params || {}),
        "cubemx.prepare": (params) => host._cubemxService.prepare(params || {}),
        "cubemx.candidate": (params) => host._cubemxService.generateCandidate(params || {}),
        "cubemx.start": (params) => host._startAgentCubeMxOperation(params || {}),
        "cubemx.status": (params) => host._cubemxService.status(params || {}),
        "cubemx.check": async (params) => {
            const result = await host._cubemxService.check(params || {});
            if (result.operationId) host._showAgentCubeMxProgress(result.operationId);
            return result;
        },
        "cubemx.execute": (params) => host._executeAgentCubeMx(params || {}),
        "cubemx.permission": (params) => host._cubemxService.permission(params || {}),
        "cubemx.cancel": (params) => host._cubemxService.cancel(params || {}),
        "flash.authorize": (params) => host._agentFlashService.authorize(params || {}),
        "flash.execute": (params) => host._agentFlashService.execute(params || {}),
        "flash.verify": (params) => host._agentFlashService.execute(params || {}, true),
        "watch.add": (params) => host._addAgentWatch(params),
        "variables.exportCsv": (params) => host._exportAgentCsv(params || {}),
        "variables.read": (params) => host._readAgentVariables(params),
        "variables.sample": (params) => host._sampleAgentVariables(params),
        "sampling.status": (params) => host._controlAgentSampling("status", params),
        "sampling.start": (params) => host._controlAgentSampling("start", params),
        "sampling.stop": (params) => host._controlAgentSampling("stop", params),
        "variables.write": (params) => host._writeAgentVariables(params),
        "variables.write.permission": (params) => host._agentWritePermission(params),
        "chip.read": () => host.readChipInfoAction(true),
        "fault.read": () => host._readAgentFault(),
        "elf.analyze": (params) => host._analyzeElf(params || {}),
        "peripherals.list": (params) => host._svdPeripheralService.list(params || {}),
        "peripherals.read": (params) => host._svdPeripheralService.read(params || {}),
        "peripherals.write": (params) => {
            host._assertWriteSessionCurrent(host._debugBridge);
            return host._svdPeripheralService.write(params || {});
        },
        "debug.status": () => host._debugControlService.status(),
        "debug.start": () => host._debugControlService.start(),
        "debug.control": (params) => host._debugControlService.control(params || {}),
        "debug.breakpoints.list": () => host._debugControlService.listBreakpoints(),
        "debug.breakpoints.update": (params) => host._debugControlService.updateBreakpoints(params || {})
    };
}
module.exports = { createAgentRoutes };
