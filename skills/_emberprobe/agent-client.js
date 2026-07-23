"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

function descriptor(workspace) {
    const file = path.join(path.resolve(workspace || process.cwd()), ".emberprobe", "agent-bridge.json");
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch {
        throw Object.assign(new Error("EmberProbe Agent Bridge descriptor is unavailable."), {
            code: "BRIDGE_UNAVAILABLE",
            details: { descriptor: file }
        });
    }
    if (value.host !== "127.0.0.1" || !Number.isInteger(value.port) || !value.token) {
        throw Object.assign(new Error("Invalid EmberProbe Agent Bridge descriptor"), {
            code: "BRIDGE_DESCRIPTOR_INVALID",
            details: { descriptor: file }
        });
    }
    return value;
}

const DIAGNOSTICS = {
    BRIDGE_UNAVAILABLE: ['extension', 'EmberProbe 扩展未激活，或工作区中的 Agent Bridge 描述文件不存在。', ['确认已安装并启用 EmberProbe 扩展。', '在 VS Code 中重新加载当前工作区后重试。'], true],
    BRIDGE_DESCRIPTOR_INVALID: ['extension', 'Agent Bridge 描述文件无效或来自不兼容版本。', ['重新加载 VS Code 窗口，让 EmberProbe 重建 Bridge。'], true],
    BRIDGE_TIMEOUT: ['extension', 'Agent Bridge 请求超时。', ['检查侧边栏是否仍显示采样中。', '若采样仍在进行，可等待完成；否则停止后重试。'], true],
    CONFIG_INCOMPLETE: ['configuration', 'EmberProbe 尚未配置调试器或 MCU 目标。', ['使用 mcu-config Skill 读取并补全 debugger 与 mcu 配置。'], false],
    OPENOCD_NOT_READY: ['environment', 'OpenOCD 未安装、路径无效或尚未通过 EmberProbe 检测。', ['在 EmberProbe 侧边栏安装 OpenOCD，或修正 openocdPath。'], false],
    PROBE_BUSY: ['resource_conflict', '调试探针正被下载、调试、芯片信息读取或另一个采样任务占用。', ['等待当前操作结束，或先停止占用探针的操作后重试。'], true],
    PROBE_NOT_FOUND: ['probe_connection', 'OpenOCD 未找到或无法打开配置的调试探针。', ['检查探针 USB 连接与驱动。', '确认所选调试器型号正确，并关闭其他调试软件。'], true],
    TARGET_NOT_CONNECTED: ['target_connection', '调试器可用，但无法连接目标 MCU。', ['检查 MCU 供电及 SWDIO/SWCLK/GND/NRST 接线。', '确认 MCU target 配置与实际芯片一致。'], true],
    TARGET_UNPOWERED: ['target_connection', '目标板未供电或目标电压过低。', ['检查目标板电源以及探针 VCC/GND 连接。'], true],
    TCL_PORT_IN_USE: ['resource_conflict', 'OpenOCD Tcl 端口被其他进程占用。', ['关闭残留 OpenOCD/调试会话，或更换 EmberProbe tclPort。'], true],
    PROBE_PERMISSION_DENIED: ['probe_connection', '操作系统拒绝访问调试探针。', ['检查 USB 驱动、权限以及是否有其他程序占用探针。'], true],
    OPENOCD_CONNECTION_TIMEOUT: ['connection_timeout', 'OpenOCD 与探针或 MCU 通信超时。', ['检查 USB、目标供电和调试接线，必要时降低 adapter speed。'], true],
    OPENOCD_CONFIG_INVALID: ['configuration', 'OpenOCD 找不到所选探针或目标配置脚本。', ['检查 EmberProbe 调试器、MCU target 与 openocdPath 配置。'], false],
    ELF_NOT_CONFIGURED: ['firmware', 'EmberProbe 尚未选择用于解析变量的 ELF。', ['在侧边栏选择最新构建的 ELF 后重试。'], false],
    ELF_READ_FAILED: ['firmware', '当前 ELF 不存在、不可读或正在被构建过程替换。', ['确认 ELF 路径有效并等待构建完成后重试。'], true],
    ELF_CHANGED: ['firmware', '采样期间 ELF 已变化，旧变量地址不再可信。', ['重新发起读取，让 EmberProbe 按最新 ELF 重新绑定变量。'], true],
    VARIABLE_NOT_FOUND: ['variable_resolution', '当前最新 ELF 中没有该变量。', ['确认变量名，必要时使用 --list 检查 ELF 符号。'], false],
    AMBIGUOUS_VARIABLE: ['variable_resolution', '变量名的大小写无关匹配不唯一。', ['使用 --list 查看候选项并提供精确名称。'], false],
    AGENT_READ_CANCELLED: ['cancelled', 'Agent 采样已被用户或其他操作取消。', ['仅在仍需要数据时重新发起读取。'], true],
    OPENOCD_START_FAILED: ['openocd', 'OpenOCD 未能建立采样连接。', ['根据 details.openocdTail 判断探针、目标供电、接线或配置问题。'], true]
};

function diagnosticForError(error, context = {}) {
    let code = error?.code || "UNKNOWN_ERROR";
    if (code === "ECONNREFUSED" || code === "ECONNRESET") code = "BRIDGE_UNAVAILABLE";
    const preset = DIAGNOSTICS[code] || [];
    return {
        ok: false,
        type: "diagnostic",
        operation: context.operation || "",
        error: {
            code,
            category: error?.category || preset[0] || "unknown",
            stage: error?.stage || context.stage || "request",
            message: error?.message || String(error),
            likelyCause: error?.likelyCause || preset[1] || "当前错误未能自动归类，请结合 message 与 details 继续判断。",
            retryable: error?.retryable ?? preset[3] ?? false,
            suggestedActions: error?.suggestedActions || preset[2] || ["保留本诊断并检查 EmberProbe/OpenOCD 日志。"],
            details: error?.details || {}
        }
    };
}

function writeDiagnostic(error, context) {
    process.stderr.write(JSON.stringify(diagnosticForError(error, context)) + "\n");
}

function call(workspace, method, params, timeoutMs = 20000) {
    const info = descriptor(workspace);
    const body = Buffer.from(JSON.stringify({ method, params: params || {} }));
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: info.host,
            port: info.port,
            path: "/v1/call",
            method: "POST",
            headers: {
                "Authorization": `Bearer ${info.token}`,
                "Content-Type": "application/json",
                "Content-Length": body.length
            },
            timeout: Math.max(1000, Math.min(2147483647, Number(timeoutMs) || 20000))
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                try {
                    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (!payload.ok) {
                        const error = new Error(payload.error?.message || "Agent Bridge request failed");
                        Object.assign(error, payload.error || {});
                        reject(error);
                    } else resolve(payload.result);
                } catch (error) { reject(error); }
            });
        });
        request.on("timeout", () => request.destroy(Object.assign(new Error("Agent Bridge request timed out"), { code: "BRIDGE_TIMEOUT" })));
        request.on("error", reject);
        request.end(body);
    });
}

module.exports = { call, descriptor, diagnosticForError, writeDiagnostic };
