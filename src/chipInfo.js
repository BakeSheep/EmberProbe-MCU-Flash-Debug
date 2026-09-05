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
    const info = parser.finish(execution.exitCode);
    report({ stage: "done", message: "读取完成" });
    return info;
}
module.exports = { ...rules, readChipInfo };
