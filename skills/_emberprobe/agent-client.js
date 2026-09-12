"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

function descriptor(workspace) {
    const root = path.resolve(workspace || process.cwd());
    const currentPointer = path.join(root, ".agents", "skills", "_emberprobe", "agent-bridge.json");
    const legacyPointer = path.join(root, ".emberprobe", "agent-bridge.json");
    // 新安装把指针与共享 Skill 运行时放在一起；升级过渡期仍可读取旧位置。
    const pointerFile = fs.existsSync(currentPointer) ? currentPointer : legacyPointer;
    let pointer;
    try {
        pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    } catch {
        throw Object.assign(new Error("EmberProbe Agent Bridge descriptor is unavailable."), {
            code: "BRIDGE_UNAVAILABLE",
            details: { descriptor: currentPointer }
        });
    }
    // 新格式：工作区文件为指针（不含 token），真实描述文件位于用户目录；旧格式直接存 token 则原地读取
    const file =
        typeof pointer.descriptorPath === "string" && pointer.descriptorPath ? pointer.descriptorPath : pointerFile;
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        throw Object.assign(new Error("Invalid EmberProbe Agent Bridge descriptor"), {
            code: "BRIDGE_DESCRIPTOR_INVALID",
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
    BRIDGE_UNAVAILABLE: [
        "extension",
        "EmberProbe 扩展未激活，或工作区中的 Agent Bridge 描述文件不存在。",
        ["确认已安装并启用 EmberProbe 扩展。", "在 VS Code 中重新加载当前工作区后重试。"],
        true
    ],
    BRIDGE_DESCRIPTOR_INVALID: [
        "extension",
        "Agent Bridge 描述文件无效或来自不兼容版本。",
        [
            "重新加载 VS Code 窗口，让 EmberProbe 重建 Bridge。",
            "若刚升级过 EmberProbe，请在侧边栏重新安装 Agent Skills（旧版脚本无法解析新的描述文件位置）。"
        ],
        true
    ],
    BRIDGE_TIMEOUT: [
        "extension",
        "Agent Bridge 请求在传输预算内没有返回；缺少服务端结果，具体原因未知。",
        [
            "超时只说明未在传输预算内收到响应；请求可能已生效、未生效或仍在进行，成败未知。",
            "状态变更类请求先用对应查询方法核对实际状态，再决定下一步，不要自动重发。",
            "只读请求在前置条件不变时最多重试一次。"
        ],
        false
    ],
    CONFIG_INCOMPLETE: [
        "configuration",
        "EmberProbe 尚未配置调试器或 MCU 目标。",
        ["使用 mcu-config Skill 读取并补全 debugger 与 mcu 配置。"],
        false
    ],
    OPENOCD_NOT_READY: [
        "environment",
        "OpenOCD 未安装、路径无效或尚未通过 EmberProbe 检测。",
        ["在 EmberProbe 侧边栏安装 OpenOCD，或修正 openocdPath。"],
        false
    ],
    PROBE_BUSY: [
        "resource_conflict",
        "调试探针正被下载、调试、芯片信息读取或另一个采样任务占用。",
        [
            "等待当前操作结束，或先停止占用探针的操作后重试。",
            "若 details.activeOperation 为 debug 且 debugState 为 running，由用户暂停目标后重试；Skill 不会隐式暂停。"
        ],
        true
    ],
    PROBE_NOT_FOUND: [
        "probe_connection",
        "OpenOCD 未找到或无法打开配置的调试探针。",
        ["检查探针 USB 连接与驱动。", "确认所选调试器型号正确，并关闭其他调试软件。"],
        true
    ],
    TARGET_NOT_CONNECTED: [
        "target_connection",
        "调试器可用，但无法连接目标 MCU。",
        ["检查 MCU 供电及 SWDIO/SWCLK/GND/NRST 接线。", "确认 MCU target 配置与实际芯片一致。"],
        true
    ],
    TARGET_UNPOWERED: [
        "target_connection",
        "目标板未供电或目标电压过低。",
        ["检查目标板电源以及探针 VCC/GND 连接。"],
        true
    ],
    TCL_PORT_IN_USE: [
        "resource_conflict",
        "OpenOCD Tcl 端口被其他进程占用。",
        ["关闭残留 OpenOCD/调试会话，或更换 EmberProbe tclPort。"],
        true
    ],
    PROBE_PERMISSION_DENIED: [
        "probe_connection",
        "操作系统拒绝访问调试探针。",
        [
            "检查 USB 驱动、权限以及是否有其他程序占用探针。",
            "Linux 上需安装 udev 规则（openocd/contrib/60-openocd.rules，执行 sudo cp 后 udevadm control --reload）或将用户加入 plugdev 等设备组，并重新插拔探针。"
        ],
        true
    ],
    OPENOCD_CONNECTION_TIMEOUT: [
        "connection_timeout",
        "OpenOCD 与探针或 MCU 通信超时。",
        ["检查 USB、目标供电和调试接线，必要时降低 adapter speed。"],
        true
    ],
    OPENOCD_CONFIG_INVALID: [
        "configuration",
        "OpenOCD 找不到所选探针或目标配置脚本。",
        ["检查 EmberProbe 调试器、MCU target 与 openocdPath 配置。"],
        false
    ],
    ELF_NOT_CONFIGURED: [
        "firmware",
        "EmberProbe 尚未选择用于解析变量的 ELF。",
        ["在侧边栏选择最新构建的 ELF 后重试。"],
        false
    ],
    ELF_READ_FAILED: [
        "firmware",
        "当前 ELF 不存在、不可读或正在被构建过程替换。",
        ["确认 ELF 路径有效并等待构建完成后重试。"],
        true
    ],
    ELF_CHANGED: [
        "firmware",
        "采样期间 ELF 已变化，旧变量地址不再可信。",
        ["重新发起读取，让 EmberProbe 按最新 ELF 重新绑定变量。"],
        true
    ],
    VARIABLE_NOT_FOUND: [
        "variable_resolution",
        "当前最新 ELF 中没有该变量。",
        ["确认变量名，必要时使用 --list 检查 ELF 符号。"],
        false
    ],
    AMBIGUOUS_VARIABLE: [
        "variable_resolution",
        "变量名的大小写无关匹配不唯一。",
        ["使用 --list 查看候选项并提供精确名称。"],
        false
    ],
    AGENT_READ_CANCELLED: ["cancelled", "Agent 采样已被用户或其他操作取消。", ["仅在仍需要数据时重新发起读取。"], true],
    OPENOCD_START_FAILED: [
        "openocd",
        "OpenOCD 未能建立采样连接。",
        ["根据 details.openocdTail 判断探针、目标供电、接线或配置问题。"],
        true
    ],
    WRITE_CONFIRMATION_INVALID: [
        "user_decision",
        "变量写入确认已过期、已使用，或写入内容发生变化。",
        ["重新请求写入摘要，并在聊天中获得用户明确授权后使用新的 confirmationId。"],
        false
    ],
    WRITE_NOT_ALLOWED: [
        "write_safety",
        "目标地址不在 ELF 的可写 RAM 段（.data/.bss）内，EmberProbe 拒绝写入。",
        ["确认变量是 RAM 中的全局变量，而非 const/Flash 数据或外设寄存器。"],
        false
    ],
    WRITE_TYPE_UNKNOWN: [
        "write_safety",
        "ELF 中缺少可验证的 DWARF 标量类型，EmberProbe 拒绝猜测写入编码。",
        ["使用包含 DWARF 调试信息的 Debug ELF 重新构建并选择固件。"],
        false
    ],
    ELF_CHANGED_DURING_WRITE_CONFIRMATION: [
        "write_safety",
        "请求确认后 ELF 已变化，旧变量地址不再可信。",
        ["检查新的 ELF 和写入目标后，重新提交写入请求并再次确认。"],
        false
    ],
    INVALID_WRITE_VALUE: [
        "write_safety",
        "写入值超出目标类型范围或非法。",
        ["按变量类型（u8/i8/u16/i16/u32/i32/f32/u64/i64/f64）提供范围内的值；64 位整数请使用十进制字符串保持精度。"],
        false
    ],
    LIVE_PANEL_NOT_OPEN: [
        "live_watch",
        "没有可用的实时图表面板，无法读取其历史缓冲。",
        ["打开“实时变量图表”面板并采集数据后重试。"],
        true
    ],
    INVALID_CSV_RANGE: [
        "live_watch",
        "CSV 导出时间范围无效。",
        [
            "优先使用 --last，或使用带日期且以 Z 结尾的 ISO 8601 UTC 时间戳。",
            "裸 HH:MM[:SS] 按运行 Skill 的本机时区解析；检查 details.requestedRange.resolvedUtc 确认实际区间。"
        ],
        false
    ],
    CSV_SERIES_NOT_FOUND: [
        "live_watch",
        "所选曲线不在目标图表面板的历史缓冲中。",
        ["检查变量名和 --panel 编号，或省略 --variables 导出全部有数据的曲线。"],
        false
    ],
    CSV_EXPORT_EMPTY: [
        "live_watch",
        "所选曲线或时间区间内没有可导出的采样点；常见原因是把 UTC 时刻作为本机 HH:MM 传入。",
        [
            "优先用 --last 指定相对区间，或传入以 Z 结尾的完整 ISO 8601 UTC 时间戳。",
            "检查 details.requestedRange.resolvedUtc 与 localTimeZone，再判断是否需要扩大范围。"
        ],
        true
    ],
    CSV_EXPORT_TIMEOUT: ["live_watch", "读取图表历史缓冲超时。", ["确认目标图表面板仍然打开，然后重试一次。"], true],
    WRITE_VERIFY_FAILED: [
        "write_safety",
        "写入后回读不一致，固件可能在每个循环中重写该变量。",
        ["向用户说明变量被固件持续覆写的可能，不要盲目重试。"],
        true
    ],
    UNSUPPORTED_VARIABLE: [
        "variable_resolution",
        "变量不是受支持的标量（或尝试写入整个复合类型）。",
        ["写入时请指定单个标量叶子路径，如 sensor.x 或 buf[0]。"],
        false
    ],
    COMPOSITE_LAYOUT_MISSING: [
        "variable_resolution",
        "变量是复合类型，但当前 ELF 缺少可用的 DWARF 布局信息，无法展开成员。",
        [
            "使用包含 DWARF 调试信息的 Debug 构建重新编译（-g 且不 strip），并在 EmberProbe 侧边栏重新选择 ELF 后重试。",
            "单个标量变量的读取不受影响。"
        ],
        false
    ],
    INVALID_VARIABLE_PATH: [
        "variable_resolution",
        "变量成员路径无效：基名不是复合类型，或路径无法在布局中解析。",
        ["确认路径写法，如 sensor.x、buf[0]、buf[1:5]。", "使用 --list 检查 ELF 符号与展开能力。"],
        false
    ],
    CONFIG_KEY_FORBIDDEN: [
        "configuration",
        "该配置键不允许通过 Agent Bridge 修改（如 openocdPath 可将探针调用引向任意可执行文件）。",
        ["openocdPath 等安全敏感配置请在 VS Code 设置或 EmberProbe 侧边栏中由用户修改。"],
        false
    ],
    FAULT_READ_FAILED: [
        "target_connection",
        "未能读取到故障寄存器。",
        ["检查探针连接与目标供电，确认 MCU target 配置与实际芯片一致。"],
        true
    ],
    SVD_NOT_CONFIGURED: [
        "configuration",
        "当前工作区没有绑定 SVD 文件。",
        ["使用 mcu-config 选择 SVD，或在 EmberProbe 侧边栏选择/下载官方 SVD。"],
        false
    ],
    SVD_READ_FAILED: ["configuration", "已绑定的 SVD 文件不存在或不可读。", ["重新选择 SVD 后重试。"], true],
    SVD_TARGET_NOT_FOUND: [
        "peripheral_resolution",
        "SVD 中没有匹配的外设、寄存器或字段路径。",
        [
            "检查 details.invalidTargets 中的全部无效路径。",
            "使用 --list 或 --query 查看当前 SVD 的实际命名后，一次性修正整批请求。"
        ],
        false
    ],
    PERIPHERAL_READ_SIDE_EFFECT: [
        "peripheral_safety",
        "该寄存器的 SVD 声明读取会清除或改变硬件状态。",
        ["为避免隐式副作用，EmberProbe 不会通过 Skill 读取该寄存器。"],
        false
    ],
    PERIPHERAL_READ_NOT_ALLOWED: [
        "peripheral_safety",
        "目标寄存器不允许读取。",
        ["检查 SVD 中的 access 属性并改用可读状态寄存器。"],
        false
    ],
    TARGET_NOT_PAUSED: [
        "debug_state",
        "SVD 外设读写或当前调试操作需要芯片已暂停。",
        ["使用 mcu-debug-control 暂停 Cortex-Debug 会话后重试。"],
        true
    ],
    INVALID_PERIPHERAL_WRITE_VALUE: [
        "peripheral_value",
        "写入值不是目标位宽内的数字，也不匹配该字段在 SVD 中声明的可精确写入枚举。",
        ["改用十进制或十六进制数值。", "如果 details.allowedEnumerations 非空，使用其中的枚举名。"],
        false
    ],
    PERIPHERAL_WRITE_NOT_ALLOWED: [
        "peripheral_safety",
        "目标不是普通 read-write 寄存器/字段，已拒绝写入。",
        ["检查 SVD access 属性；Skill 不写入只读、只写或 write-once 目标。"],
        false
    ],
    PERIPHERAL_WRITE_SEMANTICS_UNSUPPORTED: [
        "peripheral_safety",
        "SVD 声明了特殊写入语义，EmberProbe 拒绝猜测读改写行为。",
        ["请根据芯片参考手册在受控调试环境中手动处理。"],
        false
    ],
    PERIPHERAL_WRITE_CONFIRMATION_INVALID: [
        "user_decision",
        "外设写入确认已过期、已使用，或 SVD/会话/寄存器值/写入计划已变化。",
        ["重新请求写入计划，展示新的寄存器变化并再次获得用户确认。"],
        false
    ],
    PERIPHERAL_WRITE_VERIFY_FAILED: [
        "peripheral_safety",
        "外设写入后回读值不一致。",
        ["不要盲目重试；检查硬件自清零、时钟/复位状态和 SVD 是否匹配。"],
        true
    ],
    DEBUG_SESSION_NOT_ACTIVE: [
        "debug_state",
        "当前工作区没有活动的 Cortex-Debug 会话。",
        ["使用 mcu-debug-control --start 启动调试后重试。"],
        true
    ],
    DEBUG_SESSION_CONFLICT: [
        "resource_conflict",
        "当前工作区匹配到多个 Cortex-Debug 会话。",
        ["在 VS Code 中停止不需要的调试会话，保留唯一目标后重试。"],
        true
    ],
    DEBUG_ACTION_UNSUPPORTED: [
        "debug_capability",
        "Cortex-Debug 不支持请求的操作或未声明对应 DAP 能力。",
        ["查看 debug.status 的 capabilities，或升级 Cortex-Debug。"],
        false
    ],
    DEBUG_STATE_INVALID: [
        "debug_state",
        "请求的调试操作与当前运行/暂停状态不匹配。",
        ["先使用 --status 读取实际状态再选择控制命令。"],
        true
    ],
    INVALID_DEBUG_THREAD: [
        "debug_configuration",
        "调试线程 ID 必须是正整数。",
        ["省略 --thread 让 EmberProbe 使用当前停止线程，或提供有效 ID。"],
        false
    ],
    DEBUG_MEMORY_READ_UNSUPPORTED: [
        "debug_capability",
        "Cortex-Debug 未声明 DAP readMemory 能力。",
        ["升级 Cortex-Debug，并确认当前调试后端支持内存读取。"],
        false
    ],
    DEBUG_MEMORY_WRITE_UNSUPPORTED: [
        "debug_capability",
        "Cortex-Debug 未声明 DAP writeMemory 能力。",
        ["升级 Cortex-Debug，并确认当前调试后端支持内存写入。"],
        false
    ],
    DEBUG_CONTROL_TIMEOUT: [
        "debug_state",
        "调试适配器未在限时内返回期望的运行/暂停事件。",
        [
            "先运行 --status 确认实际状态，不要自动重复发送原命令。",
            "如果目标仍在运行，且 --pause 或 --restart 也返回 DEBUG_CONTROL_TIMEOUT，由用户明确执行 --stop，再执行 --start 重建会话。"
        ],
        true
    ],
    DEBUG_CONTROL_BUSY: [
        "debug_state",
        "上一个调试控制操作尚未被 DAP 事件确认完成。",
        ["先运行 --status 确认状态，再决定是否发送新操作；不要并发或自动重试。"],
        true
    ],
    BREAKPOINT_PATH_OUTSIDE_WORKSPACE: [
        "debug_safety",
        "源码断点路径超出了当前工作区。",
        ["使用当前项目内的源文件相对路径。"],
        false
    ],
    BREAKPOINT_SOURCE_NOT_FOUND: [
        "debug_configuration",
        "指定的断点源文件不存在。",
        ["检查 --source 路径与工作区。"],
        false
    ],
    BREAKPOINT_NOT_FOUND: [
        "debug_configuration",
        "没有找到要删除或切换的断点。",
        ["先使用 --breakpoints 列出当前断点。"],
        false
    ]
};

// Bridge 方法按副作用分类：只读方法在传输超时后可在相同前置条件下最多重试一次；
// 其余方法(状态变更)超时后结果未知，必须查询实际状态、不得自动重发。未知方法按状态变更安全处理。
const READ_ONLY_METHODS = new Set([
    "cubemx.inspect",
    "config.get",
    "chip.read",
    "fault.read",
    "elf.analyze",
    "peripherals.list",
    "peripherals.read",
    "debug.status",
    "debug.breakpoints.list",
    "variables.read",
    "variables.sample",
    "variables.exportCsv"
]);

// 状态变更超时后用于核对实际结果的查询方法；未列出的方法给出通用查询提示。
const STATUS_QUERY_FOR = {
    "cubemx.execute": "cubemx.inspect",
    "config.set": "config.get",
    "debug.start": "debug.status",
    "debug.control": "debug.status",
    "debug.breakpoints.update": "debug.breakpoints.list",
    "peripherals.write": "peripherals.read",
    "variables.write": "variables.read"
};

function isReadOnlyMethod(method) {
    return READ_ONLY_METHODS.has(method);
}

function diagnosticForError(error, context = {}) {
    let code = error?.code || "UNKNOWN_ERROR";
    if (code === "ECONNREFUSED" || code === "ECONNRESET") code = "BRIDGE_UNAVAILABLE";
    const preset = DIAGNOSTICS[code] || [];
    const details = { ...(error?.details || {}) };
    let retryable = error?.retryable ?? preset[3] ?? false;
    let suggestedActions = error?.suggestedActions || preset[2] || ["保留本诊断并检查 EmberProbe/OpenOCD 日志。"];
    // 传输超时缺少服务端结果：只读方法可在前置不变时重试一次；状态变更方法结果未知，
    // 必须查询实际状态、不得自动重发，也不声称请求已取消。
    if (code === "BRIDGE_TIMEOUT") {
        const method = details.method || context.operation || "";
        const readOnly = isReadOnlyMethod(method);
        details.resultUnknown = !readOnly;
        if (error?.retryable === undefined) retryable = readOnly;
        if (!error?.suggestedActions)
            suggestedActions = readOnly
                ? [
                      "超时只说明未在预算内收到响应，不代表请求失败；先区分事实与假设。",
                      "这是只读查询：前置条件不变时最多重试一次，仍超时则保留诊断并检查 Bridge 与扩展状态。"
                  ]
                : [
                      "超时只说明未在预算内收到响应；这是状态变更请求，成败未知，需核对实际状态后再判断。",
                      `先用 ${STATUS_QUERY_FOR[method] || "对应查询方法"} 核对实际状态，再决定下一步；不要自动重发该请求。`,
                      "确认未生效且前置条件允许后，才可重新发起。"
                  ];
    }
    return {
        ok: false,
        type: "diagnostic",
        operation: context.operation || "",
        error: {
            code,
            category: error?.category || preset[0] || "unknown",
            stage: error?.stage || context.stage || "request",
            message: error?.message || String(error),
            likelyCause:
                error?.likelyCause || preset[1] || "当前错误未能自动归类，请结合 message 与 details 继续判断。",
            retryable,
            suggestedActions,
            details
        }
    };
}

function writeDiagnostic(error, context) {
    process.stderr.write(JSON.stringify(diagnosticForError(error, context)) + "\n");
}

function call(workspace, method, params, timeoutMs = 20000) {
    const info = descriptor(workspace);
    const body = Buffer.from(JSON.stringify({ method, params: params || {} }));
    // 实际(钳制后)超时预算与起始时间随超时错误一并上报，供 agent 判断耗时与恢复动作。
    const budget = Math.max(1000, Math.min(2147483647, Number(timeoutMs) || 20000));
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: info.host,
                port: info.port,
                path: "/v1/call",
                method: "POST",
                headers: {
                    Authorization: `Bearer ${info.token}`,
                    "Content-Type": "application/json",
                    "Content-Length": body.length
                },
                timeout: budget
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    try {
                        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        if (!payload.ok) {
                            const error = new Error(payload.error?.message || "Agent Bridge request failed");
                            Object.assign(error, payload.error || {});
                            reject(error);
                        } else resolve(payload.result);
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );
        request.on("timeout", () =>
            request.destroy(
                Object.assign(new Error("Agent Bridge request timed out"), {
                    code: "BRIDGE_TIMEOUT",
                    details: { method, timeoutMs: budget, elapsedMs: Date.now() - startedAt }
                })
            )
        );
        request.on("error", (error) => {
            // 连接层失败(ECONNREFUSED/ECONNRESET 等)保留原始传输错误码与方法上下文，
            // 由 diagnosticForError 映射为 BRIDGE_UNAVAILABLE，与请求超时区分描述。
            const err = /** @type {NodeJS.ErrnoException & { details?: Record<string, unknown> }} */ (error);
            if (err && typeof err === "object" && !err.details)
                err.details = { method, transportError: err.code || "transport" };
            reject(err);
        });
        request.end(body);
    });
}

module.exports = { call, descriptor, diagnosticForError, writeDiagnostic, isReadOnlyMethod };
