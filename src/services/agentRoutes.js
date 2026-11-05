"use strict";
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const { normalizeInventoryQuery } = require("../../skills/_emberprobe/probe-profile");
const { AgentDebugInspection } = require("./agentDebugInspection");
const { RttAgentService } = require("./rttAgentService");

function createAgentRoutes(host, probes = listProbes) {
    const listProbes = probes;
    let inspection;
    const rtt = new RttAgentService(host);
    return {
        "config.get": () => host._configurationSnapshot(),
        "probe.list": async (params = {}) => {
            const query = normalizeInventoryQuery(params);
            const [inventory, selectedId] = await Promise.all([
                listProbes(query.vidPid.length ? query : { family: query.family }),
                // Resolved against every connected probe, so a filtered list cannot make a device look unique.
                // The marker is informational; failing to resolve it never fails the listing.
                Promise.resolve()
                    .then(() => host._connectedProbes.selectedDeviceId?.())
                    .catch(() => "")
            ]);
            if (typeof selectedId !== "string" || !selectedId || !Array.isArray(inventory?.devices)) return inventory;
            return {
                ...inventory,
                devices: inventory.devices.map((device) =>
                    String(device?.id || "").toUpperCase() === selectedId.toUpperCase()
                        ? { ...device, selected: true }
                        : device
                )
            };
        },
        "config.set": (params) => host._agentOps.setConfiguration(params.values || {}),
        "cubemx.detect": async () => {
            // Both generators are reported; the selected project file decides which one runs.
            const cubemx2 = await host._cubemxConfiguration.detect("cubemx2");
            const tool = await host._cubemxConfiguration.detect();
            if (!tool && !cubemx2) return null;
            return tool ? { ...tool, cubemx2: cubemx2 || null } : { cubemx: null, cubemx2 };
        },
        "cubemx.inspect": (params) => host._cubemxService.inspect(params || {}),
        "cubemx.query": (params) => host._cubemxService.query(params || {}),
        "cubemx.prepare": (params) => host._cubemxService.prepare(params || {}),
        "cubemx.candidate": (params) => host._cubemxService.generateCandidate(params || {}),
        "cubemx.start": (params) => host._agentOps.startCubeMxOperation(params || {}),
        "cubemx.status": (params) => host._cubemxService.status(params || {}),
        "cubemx.check": async (params) => {
            const result = await host._cubemxService.check(params || {});
            if (result.operationId) host._agentOps.showCubeMxProgress(result.operationId);
            return result;
        },
        "cubemx.execute": (params) => host._agentOps.executeCubeMx(params || {}),
        "cubemx.permission": (params) => host._cubemxService.permission(params || {}),
        "cubemx.cancel": (params) => host._cubemxService.cancel(params || {}),
        "flash.authorize": (params) => host._agentFlashService.authorize(params || {}),
        "flash.execute": (params) => host._agentFlashService.execute(params || {}),
        "flash.verify": (params) => host._agentFlashService.execute(params || {}, true),
        "flash.permission": (params) => host._agentFlashService.permission(params || {}),
        "watch.add": (params) => host._agentOps.addWatch(params),
        "variables.exportCsv": (params) => host._agentOps.exportCsv(params || {}),
        "variables.read": (params) => host._agentOps.readVariables(params),
        "variables.sample": (params) => host._agentOps.sampleVariables(params),
        "sampling.status": (params) => host._agentOps.controlSampling("status", params),
        "sampling.start": (params) => host._agentOps.controlSampling("start", params),
        "sampling.stop": (params) => host._agentOps.controlSampling("stop", params),
        "rtt.status": (params) => rtt.status(params),
        "rtt.read": (params) => rtt.read(params),
        "rtt.start": (params) => rtt.start(params),
        "rtt.stop": (params) => rtt.stop(params),
        "variables.write": (params) => host._writes.writeAgentVariables(params),
        "variables.write.permission": (params) => host._writes.agentPermission(params),
        "chip.read": () => host.readChipInfoAction(true),
        "fault.read": () => host._agentOps.readFault(),
        "elf.analyze": (params) => host._analyzeElf(params || {}),
        "peripherals.list": (params) => host._svdPeripheralService.list(params || {}),
        "peripherals.read": (params) => host._svdPeripheralService.read(params || {}),
        "peripherals.write": (params) => host._svdPeripheralService.write(params || {}),
        "debug.status": () => host._debugControlService.status(),
        "debug.inspect": (params) => {
            inspection ||= new AgentDebugInspection(host._debugBridge);
            return inspection.inspect(params || {});
        },
        "rtos.status": () => host._rtosViewService.status(),
        "rtos.snapshot": (params) => {
            if (params?.includeStackUsage !== undefined && typeof params.includeStackUsage !== "boolean")
                throw Object.assign(new Error("includeStackUsage must be boolean"), {
                    code: "DEBUG_INSPECTION_INVALID"
                });
            return host._rtosViewService.refresh(params?.includeStackUsage !== false);
        },
        "debug.select": (params) => host._selectDebugSession(params || {}),
        "debug.start": (params) => host._debugControlService.start(params || {}),
        "debug.control": (params) => host._debugControlService.control(params || {}),
        "debug.breakpoints.list": () => host._debugControlService.listBreakpoints(),
        "debug.breakpoints.update": (params) => host._debugControlService.updateBreakpoints(params || {})
    };
}
module.exports = { createAgentRoutes };
