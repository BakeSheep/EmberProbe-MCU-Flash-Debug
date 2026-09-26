"use strict";
const { isSafeCfg } = require("./openocdRunner");
const { runOpenOcdOnce } = require("./services/openocdExec");
const rules = require("./chip/rules");
const { createChipParser } = require("./chip/parser");
async function readChipInfo(vscode, options, onProgress) {
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) throw new Error("Invalid OpenOCD configuration name");
    const report = typeof onProgress === "function" ? onProgress : () => {};
    const cmds = rules.buildChipInfoCommands(options.target);
    const parser = createChipParser(options.target);
    report({ stage: "start", message: "正在读取芯片信息…" });
    let execution;
    try {
        execution = await runOpenOcdOnce({
            executable: options.executable,
            probe: options.probe,
            target: options.target,
            transport: options.transport,
            probeSerial: options.probeSerial,
            adapterSpeedKhz: options.adapterSpeedKhz,
            inventory: options.inventory,
            cwd: options.cwd,
            timeoutMs: 15000,
            buildCommands: () => cmds,
            onLine: parser.handleLine,
            buildTimeoutError: () =>
                Object.assign(new Error("读取芯片信息超时（15s）：请检查接线、供电与探针占用情况"), {
                    i18nKey: "chip.timeout"
                })
        });
    } finally {
        try {
            report({ stage: "raw", commands: cmds.slice(), lines: parser.rawLines() });
        } catch (e) {
            /* ignore */
        }
    }
    if (execution.exitCode !== 0 && execution.diagnostic) {
        throw Object.assign(new Error(execution.diagnostic.message), execution.diagnostic);
    }
    const info = parser.finish(execution.exitCode);
    report({ stage: "done", message: "读取完成" });
    return info;
}
async function controlTarget(options, action) {
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) throw new Error("Invalid OpenOCD configuration name");
    const operations = {
        pause: { command: "halt", expected: "running" },
        continue: { command: "resume", expected: "halted" },
        reset: { command: "reset run" }
    };
    const operation = operations[action];
    if (!operation)
        throw Object.assign(new Error(`Unsupported target action: ${action}`), { code: "CHIP_ACTION_INVALID" });
    const check = operation.expected
        ? `poll; if {[[target current] curstate] ne "${operation.expected}"} { error "Target is no longer ${operation.expected}" }; `
        : "";
    const script =
        `set _ep_rc [catch { ${check}${operation.command}; poll; set _ep_state [[target current] curstate] } _ep_msg]; ` +
        'if {$_ep_rc} { echo "EP_CONTROL_ERROR $_ep_msg" } else { echo "EP_CONTROL_OK $_ep_state" }';
    let outcome = null;
    const execution = await (options.run || runOpenOcdOnce)({
        executable: options.executable,
        probe: options.probe,
        target: options.target,
        transport: options.transport,
        probeSerial: options.probeSerial,
        adapterSpeedKhz: options.adapterSpeedKhz,
        inventory: options.inventory,
        cwd: options.cwd,
        timeoutMs: 15000,
        buildCommands: () => ["init", script, "shutdown"],
        onLine: (line) => {
            const match = line.match(/\bEP_CONTROL_(OK|ERROR)\s+(.+)$/);
            if (match) outcome = { ok: match[1] === "OK", value: match[2].trim() };
        }
    });
    if (!outcome?.ok || execution.exitCode !== 0) {
        throw Object.assign(
            new Error(
                outcome?.ok
                    ? execution.diagnostic?.message || "OpenOCD control failed"
                    : outcome?.value || execution.diagnostic?.message || "OpenOCD control failed"
            ),
            { code: "CHIP_CONTROL_FAILED" }
        );
    }
    return { state: outcome.value };
}
module.exports = { ...rules, readChipInfo, controlTarget };
