"use strict";
// MCP 工具目录：与 Bridge 方法一一对应或少量合并。schema 只负责提前拦截明显错误，
// 最终校验仍由 Bridge（src/validation.js 等）完成。readOnlyHint 由 agent-client 的方法集合派生。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { READ_ONLY_METHODS, OBSERVATION_METHODS } = require("../../skills/_emberprobe/agent-client");

const TOOLSETS = Object.freeze(["core", "debug", "cubemx"]);
const DEFAULT_TOOLSETS = Object.freeze(["core", "debug"]);

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, minimum, maximum, extra = {}) => ({
    type: "integer",
    description,
    minimum,
    maximum,
    ...extra
});
const bool = (description) => ({ type: "boolean", description });
const strings = (description, extra = {}) => ({
    type: "array",
    items: { type: "string", minLength: 1 },
    description,
    ...extra
});
const object = (properties = {}, required = []) => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false
});
const confirmation = {
    confirmationId: str(
        "Only for clients without elicitation: the ID returned with the plan, sent after the user approved that plan."
    ),
    remember: bool("Only when the user explicitly chose the 24-hour workspace permission for this plan.")
};
// probeSerial 保持字符串原样传递，不做大小写或前导零处理。
const flashPlan = {
    elf: str("ELF path; defaults to the workspace selection or the newest build."),
    target: str("OpenOCD target script, e.g. target/stm32f4x.cfg; never guess it."),
    probe: str("OpenOCD interface script, e.g. interface/stlink.cfg; never guess it."),
    transport: str("Transport override.", { enum: ["auto", "swd", "jtag", "hla_swd", "hla_jtag"] }),
    probeSerial: str("USB serial exactly as reported; leave empty for a uniquely matched probe."),
    adapterSpeedKhz: int("Adapter clock in kHz; 0 uses the script default.", 0, 2147483647)
};
const variableItem = {
    anyOf: [
        { type: "string", minLength: 1 },
        object(
            { name: str("Variable or member path, e.g. sensor.x, buf[0], main.c::g_cfg"), type: str("Explicit type") },
            ["name"]
        )
    ]
};
const variables = { type: "array", items: variableItem, minItems: 1, maxItems: 64, description: "Variables to read." };
const toSpecs = (items) => (items || []).map((item) => (typeof item === "string" ? { name: item } : item));
const permissionKinds = { kind: str("Permission store.", { enum: ["flash", "variables", "cubemx"] }) };
const PERMISSION_METHODS = {
    flash: "flash.permission",
    variables: "variables.write.permission",
    cubemx: "cubemx.permission"
};

function timestamp(value, name) {
    if (value === undefined) return undefined;
    const parsed = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(parsed))
        throw Object.assign(new Error(`${name} must be epoch milliseconds or an ISO 8601 timestamp`), {
            code: "INVALID_CSV_RANGE"
        });
    return parsed;
}

function candidateHash(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * @typedef {{ method: string, params?: Record<string, any>, timeoutMs?: number }} BridgeRequest
 * @typedef {{
 *   name: string, toolset: string, title: string, description: string, methods: string[],
 *   inputSchema: Record<string, any>, request?: (args: Record<string, any>) => BridgeRequest,
 *   kind?: "bridge" | "flash", confirm?: boolean, destructive?: boolean, mutates?: boolean,
 *   hardware?: boolean, operation?: string, cancel?: (args: Record<string, any>) => BridgeRequest | null
 * }} ToolDefinition
 */
/** @type {ToolDefinition[]} */
const TOOLS = [
    {
        name: "config_get",
        toolset: "core",
        title: "Read EmberProbe configuration",
        description: "Read the workspace ELF, debugger, MCU target, SVD, transport and sampling settings.",
        methods: ["config.get"],
        inputSchema: object(),
        request: () => ({ method: "config.get" })
    },
    {
        name: "config_set",
        toolset: "core",
        title: "Update EmberProbe configuration",
        description:
            "Set workspace configuration values. openocdPath and cubemxPath are user-only and are rejected. Set only values the user confirmed; never guess a target or probe.",
        methods: ["config.set"],
        inputSchema: object(
            {
                values: object({
                    elf: str("ELF path"),
                    debugger: str("OpenOCD interface script"),
                    mcu: str("OpenOCD target script"),
                    svd: str("SVD path; empty clears it"),
                    iocPath: str("CubeMX .ioc path"),
                    transport: str("Transport", { enum: ["auto", "swd", "jtag", "hla_swd", "hla_jtag"] }),
                    rtos: str("OpenOCD RTOS awareness name, case-sensitive; empty disables"),
                    probeSerial: str("Probe USB serial, kept verbatim"),
                    adapterSpeedKhz: int("Adapter clock in kHz", 0, 2147483647),
                    sampleIntervalMs: { type: "number", minimum: 5, maximum: 10000 },
                    sampleFrequencyHz: { type: "number", minimum: 0.1, maximum: 200 },
                    tclPort: int("OpenOCD Tcl port", 1, 65535)
                })
            },
            ["values"]
        ),
        request: (args) => ({ method: "config.set", params: { values: args.values } })
    },
    {
        name: "probe_list",
        toolset: "core",
        title: "List debug probes",
        description: "List attached USB debug probes with serials and driver state.",
        methods: ["probe.list"],
        inputSchema: object({
            family: str("Probe family filter, e.g. stlink, jlink, cmsis-dap; default all"),
            vidPid: {
                type: "array",
                maxItems: 16,
                items: { type: "array", items: int("USB id", 0, 65535), minItems: 2, maxItems: 2 },
                description: "Optional [VID, PID] pairs"
            }
        }),
        request: (args) => ({ method: "probe.list", params: args })
    },
    {
        name: "chip_read",
        toolset: "core",
        title: "Read chip identity",
        description: "Connect through the probe and read core, device ID, Flash size, debug link and run state.",
        methods: ["chip.read"],
        hardware: true,
        inputSchema: object({
            sections: { type: "array", items: str("Field group", { enum: ["identity", "debug", "runtime"] }) },
            fields: strings("Individual fields such as cpuid or pc")
        }),
        request: (args) => ({
            method: "chip.read",
            params: { sections: args.sections || (args.fields?.length ? [] : ["identity"]), fields: args.fields || [] }
        })
    },
    {
        name: "fault_read",
        toolset: "core",
        title: "Read Cortex-M fault state",
        description: "Read CFSR/HFSR/MMFAR/BFAR and the faulting PC with symbols.",
        methods: ["fault.read"],
        hardware: true,
        inputSchema: object(),
        request: () => ({ method: "fault.read" })
    },
    {
        name: "elf_analyze",
        toolset: "core",
        title: "Analyze ELF memory usage",
        description: "Report Flash/RAM usage by region, section and largest symbols for the workspace ELF.",
        methods: ["elf.analyze"],
        inputSchema: object({
            top: int("Number of largest symbols", 1, 1000),
            mapFile: str("Linker .map path"),
            linkerScript: str("Linker script path")
        }),
        request: (args) => ({ method: "elf.analyze", params: args })
    },
    {
        name: "flash_program",
        toolset: "core",
        title: "Program firmware",
        description:
            "Program the ELF into target Flash (program, verify, reset). Runs preflight first; if it is not ready, report diagnostics and stop. Requires the user's approval of the returned plan.",
        methods: ["flash.authorize", "flash.execute"],
        kind: "flash",
        operation: "flash.execute",
        confirm: true,
        destructive: true,
        hardware: true,
        inputSchema: object({ ...flashPlan, ...confirmation })
    },
    {
        name: "flash_verify",
        toolset: "core",
        title: "Verify firmware",
        description:
            "Compare on-chip Flash with the ELF without programming; briefly halts the target. Always one-time approval.",
        methods: ["flash.authorize", "flash.verify"],
        kind: "flash",
        operation: "flash.verify",
        confirm: true,
        hardware: true,
        inputSchema: object({ ...flashPlan, confirmationId: confirmation.confirmationId })
    },
    {
        name: "permission_get",
        toolset: "core",
        title: "Read remembered permission",
        description: "Show whether a 24-hour workspace permission is active for flash, variable writes or CubeMX.",
        methods: Object.values(PERMISSION_METHODS),
        inputSchema: object(permissionKinds, ["kind"]),
        request: (args) => ({ method: PERMISSION_METHODS[args.kind], params: { action: "status" } })
    },
    {
        name: "permission_reset",
        toolset: "core",
        title: "Reset remembered permission",
        description: "Clear pending confirmations and the remembered workspace permission.",
        methods: Object.values(PERMISSION_METHODS),
        mutates: true,
        inputSchema: object(permissionKinds, ["kind"]),
        request: (args) => ({ method: PERMISSION_METHODS[args.kind], params: { action: "reset" } })
    },
    {
        name: "variables_read",
        toolset: "core",
        title: "Read variables once",
        description:
            "Read global variables from the latest ELF/DWARF, reusing live sampling or briefly connecting. Types come from DWARF unless given.",
        methods: ["variables.read"],
        hardware: true,
        inputSchema: object({ variables }, ["variables"]),
        request: (args) => ({ method: "variables.read", params: { variables: toSpecs(args.variables) } })
    },
    {
        name: "variables_sample",
        toolset: "core",
        title: "Sample variables",
        description: "Read variables repeatedly and return every sample.",
        methods: ["variables.sample"],
        hardware: true,
        inputSchema: object(
            {
                variables,
                count: int("Samples", 2, 1000, { default: 10 }),
                intervalMs: int("Interval in ms", 5, 60000, { default: 200 })
            },
            ["variables"]
        ),
        request: (args) => {
            const count = args.count ?? 10;
            const intervalMs = args.intervalMs ?? 200;
            return {
                method: "variables.sample",
                params: { variables: toSpecs(args.variables), count, intervalMs },
                timeoutMs: Math.min(2147483647, count * intervalMs + 30000)
            };
        }
    },
    {
        name: "variables_write",
        toolset: "core",
        title: "Write variables",
        description:
            "Write scalar RAM variables (.data/.bss) and read them back. Requires the user's approval of the returned plan.",
        methods: ["variables.write"],
        confirm: true,
        destructive: true,
        hardware: true,
        inputSchema: object(
            {
                values: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: object(
                        {
                            name: str("Scalar variable or leaf path"),
                            value: { type: ["string", "number", "boolean"], description: "64-bit integers as strings" }
                        },
                        ["name", "value"]
                    )
                },
                ...confirmation
            },
            ["values"]
        ),
        request: (args) => ({ method: "variables.write", params: { values: args.values } })
    },
    {
        name: "variables_export_csv",
        toolset: "core",
        title: "Export chart history as CSV",
        description: "Export samples from an open Live Watch chart panel. Timestamps are UTC.",
        methods: ["variables.exportCsv"],
        inputSchema: object({
            variables: strings("Series to export; default all with data"),
            lastSeconds: { type: "number", exclusiveMinimum: 0, description: "Relative range ending now" },
            from: { type: ["string", "number"], description: "ISO 8601 UTC (ending in Z) or epoch ms" },
            to: { type: ["string", "number"], description: "ISO 8601 UTC (ending in Z) or epoch ms; default now" },
            panelId: int("Chart panel number; default the focused panel", 1, 1000)
        }),
        request: (args) => {
            const to = timestamp(args.to, "to") ?? Date.now();
            let from = timestamp(args.from, "from");
            if (args.lastSeconds !== undefined) {
                if (from !== undefined)
                    throw Object.assign(new Error("lastSeconds cannot be combined with from"), {
                        code: "INVALID_CSV_RANGE"
                    });
                from = to - args.lastSeconds * 1000;
            }
            const params = { variables: args.variables || [], to };
            if (from !== undefined) params.from = from;
            if (args.panelId !== undefined) params.panelId = args.panelId;
            return { method: "variables.exportCsv", params };
        }
    },
    {
        name: "watch_add",
        toolset: "core",
        title: "Add variables to the watch list",
        description: "Add variables to the sidebar watch list, the live chart, or both.",
        methods: ["watch.add"],
        inputSchema: object(
            {
                variables: strings("Variable names", { minItems: 1, maxItems: 64 }),
                types: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description: "Explicit types by name"
                },
                destination: str("Where to add them", { enum: ["sidebar", "chart", "both"], default: "sidebar" })
            },
            ["variables"]
        ),
        request: (args) => ({
            method: "watch.add",
            params: { variables: args.variables, types: args.types || {}, destination: args.destination || "sidebar" }
        })
    },
    {
        name: "sampling_status",
        toolset: "core",
        title: "Read live sampling status",
        description: "Report whether persistent live sampling is running and at what rate.",
        methods: ["sampling.status"],
        inputSchema: object(),
        request: () => ({ method: "sampling.status" })
    },
    {
        name: "sampling_control",
        toolset: "core",
        title: "Start or stop live sampling",
        description: "Start persistent sampling of the watch list, or stop it (also cancels temporary Agent reads).",
        methods: ["sampling.start", "sampling.stop"],
        hardware: true,
        inputSchema: object(
            { action: str("Action", { enum: ["start", "stop"] }), intervalMs: int("Interval for start", 5, 10000) },
            ["action"]
        ),
        request: (args) => ({
            method: `sampling.${args.action}`,
            params: args.action === "start" && args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}
        })
    },
    {
        name: "peripherals_list",
        toolset: "core",
        title: "List SVD peripherals",
        description: "Search peripherals, registers and fields in the bound SVD.",
        methods: ["peripherals.list"],
        inputSchema: object({ query: str("Case-insensitive search"), peripheral: str("Limit to one peripheral") }),
        request: (args) => ({ method: "peripherals.list", params: args })
    },
    {
        name: "peripherals_read",
        toolset: "core",
        title: "Read peripheral registers",
        description:
            "Read registers or fields by SVD path while the target is paused. Read-side-effect registers are refused.",
        methods: ["peripherals.read"],
        hardware: true,
        inputSchema: object({ targets: strings("Paths such as GPIOA.ODR or RCC.CR.HSEON", { minItems: 1 }) }, [
            "targets"
        ]),
        request: (args) => ({ method: "peripherals.read", params: { targets: args.targets } })
    },
    {
        name: "peripherals_write",
        toolset: "core",
        title: "Write peripheral registers",
        description:
            "Write read-write registers or fields while paused, then read back. Always one-time approval of the returned plan.",
        methods: ["peripherals.write"],
        confirm: true,
        destructive: true,
        hardware: true,
        inputSchema: object(
            {
                writes: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: object({ target: str("Register or field path"), value: { type: ["string", "number"] } }, [
                        "target",
                        "value"
                    ])
                },
                confirmationId: confirmation.confirmationId
            },
            ["writes"]
        ),
        request: (args) => ({
            method: "peripherals.write",
            params: { writes: args.writes.map((item) => ({ target: item.target, value: String(item.value) })) }
        })
    },
    {
        name: "debug_status",
        toolset: "debug",
        title: "Read debug session status",
        description: "Report active debug sessions, run state, stop reason and adapter capabilities.",
        methods: ["debug.status"],
        inputSchema: object(),
        request: () => ({ method: "debug.status" })
    },
    {
        name: "debug_inspect",
        toolset: "debug",
        title: "Inspect a paused target",
        description:
            "List threads, a thread's stack, a frame's scopes or a variable reference's children (paged). Handles expire on resume.",
        methods: ["debug.inspect"],
        inputSchema: object(
            {
                action: str("What to list", { enum: ["threads", "stack", "scopes", "variables"] }),
                threadId: int("Thread for stack", 1, Number.MAX_SAFE_INTEGER),
                frame: int("Frame id for scopes", 0, Number.MAX_SAFE_INTEGER),
                reference: int("Variables reference", 1, Number.MAX_SAFE_INTEGER),
                start: int("Page start", 0, 100000),
                count: int("Page size", 1, 100),
                filter: str("Child filter", { enum: ["named", "indexed"] })
            },
            ["action"]
        ),
        request: (args) => ({ method: "debug.inspect", params: args })
    },
    {
        name: "debug_breakpoints_list",
        toolset: "debug",
        title: "List breakpoints",
        description: "List source and function breakpoints with verification state.",
        methods: ["debug.breakpoints.list"],
        inputSchema: object(),
        request: () => ({ method: "debug.breakpoints.list" })
    },
    {
        name: "debug_start",
        toolset: "debug",
        title: "Start the debugger",
        description: "Start the built-in EmberProbe debug session for the workspace ELF.",
        methods: ["debug.start"],
        hardware: true,
        inputSchema: object(),
        request: () => ({ method: "debug.start" })
    },
    {
        name: "debug_select",
        toolset: "debug",
        title: "Select a debug session",
        description: "Choose which debug session or shared group later debug tools use.",
        methods: ["debug.select"],
        inputSchema: object({
            sessionId: str("Session id from debug_status"),
            serverGroup: str("Shared server group id"),
            targetProcessor: int("Zero-based core index", 0, 31)
        }),
        request: (args) => ({ method: "debug.select", params: args })
    },
    {
        name: "debug_control",
        toolset: "debug",
        title: "Control execution",
        description:
            "Pause, continue, step, restart or stop the selected session. Check debug_status first; never repeat after a timeout.",
        methods: ["debug.control"],
        destructive: true,
        hardware: true,
        inputSchema: object(
            {
                action: str("Action", {
                    enum: ["pause", "continue", "stepOver", "stepIn", "stepOut", "restart", "stop"]
                }),
                threadId: int("Thread to control", 1, Number.MAX_SAFE_INTEGER)
            },
            ["action"]
        ),
        request: (args) => ({ method: "debug.control", params: args })
    },
    {
        name: "debug_breakpoints_update",
        toolset: "debug",
        title: "Change breakpoints",
        description: "Add, remove, enable or disable a source breakpoint (file + line) or function breakpoint.",
        methods: ["debug.breakpoints.update"],
        inputSchema: object(
            {
                action: str("Change", { enum: ["add", "remove", "enable", "disable"] }),
                type: str("Breakpoint kind", { enum: ["source", "function"] }),
                file: str("Workspace source path for source breakpoints"),
                line: int("Line", 1, 10000000),
                column: int("Column", 1, 100000),
                function: str("Function name for function breakpoints"),
                condition: str("Condition expression"),
                hitCondition: str("Hit count condition"),
                logMessage: str("Logpoint message")
            },
            ["action", "type"]
        ),
        request: (args) => ({ method: "debug.breakpoints.update", params: args })
    },
    {
        name: "rtos_status",
        toolset: "debug",
        title: "Read RTOS awareness status",
        description: "Report whether RTOS awareness is configured and available in the native session.",
        methods: ["rtos.status"],
        inputSchema: object(),
        request: () => ({ method: "rtos.status" })
    },
    {
        name: "rtos_snapshot",
        toolset: "debug",
        title: "Snapshot RTOS tasks",
        description: "Read FreeRTOS tasks, states, priorities and stack usage from a paused native session.",
        methods: ["rtos.snapshot"],
        inputSchema: object({ includeStackUsage: bool("Include stack high-water marks (default true)") }),
        request: (args) => ({
            method: "rtos.snapshot",
            params: { includeStackUsage: args.includeStackUsage !== false }
        })
    },
    {
        name: "cubemx_detect",
        toolset: "cubemx",
        title: "Detect STM32CubeMX",
        description: "Report the configured STM32CubeMX executable and version.",
        methods: ["cubemx.detect"],
        inputSchema: object(),
        request: () => ({ method: "cubemx.detect" })
    },
    {
        name: "cubemx_inspect",
        toolset: "cubemx",
        title: "Inspect the .ioc project",
        description: "Summarize the CubeMX project, or list full key/values filtered by prefix.",
        methods: ["cubemx.inspect"],
        inputSchema: object({ full: bool("Return all keys"), prefix: str("Key prefix filter") }),
        request: (args) => ({
            method: "cubemx.inspect",
            params: { summary: !args.full, full: !!args.full, ...(args.prefix ? { prefix: args.prefix } : {}) }
        })
    },
    {
        name: "cubemx_status",
        toolset: "cubemx",
        title: "Read CubeMX operation status",
        description: "Report a generation or deep-check operation by operationId or requestId.",
        methods: ["cubemx.status"],
        inputSchema: object({ operationId: str("Operation id"), requestId: str("Request id") }),
        request: (args) => ({ method: "cubemx.status", params: args })
    },
    {
        name: "cubemx_prepare",
        toolset: "cubemx",
        title: "Prepare CubeMX generation",
        description: "Validate the project or a candidate .ioc and summarize what generation would change.",
        methods: ["cubemx.prepare"],
        inputSchema: object({ full: bool("Full report"), candidatePath: str("Candidate .ioc path") }),
        request: (args) => ({
            method: "cubemx.prepare",
            params: {
                summary: !args.full,
                full: !!args.full,
                ...(args.candidatePath ? { candidatePath: path.resolve(args.candidatePath) } : {})
            }
        })
    },
    {
        name: "cubemx_candidate",
        toolset: "cubemx",
        title: "Write a candidate .ioc",
        description: "Write a modified copy of the .ioc with key changes/deletions; the original is untouched.",
        methods: ["cubemx.candidate"],
        inputSchema: object(
            {
                outputPath: str("Where to write the candidate .ioc"),
                changes: { type: "object", additionalProperties: { type: "string" } },
                deletions: strings("Keys to delete"),
                changesFile: str("JSON file with changes")
            },
            ["outputPath"]
        ),
        request: (args) => ({
            method: "cubemx.candidate",
            params: { ...args, outputPath: path.resolve(args.outputPath) }
        })
    },
    {
        name: "cubemx_check",
        toolset: "cubemx",
        title: "Check CubeMX project",
        description: "Quick static check, or start a deep check that runs CubeMX in a sandbox copy.",
        methods: ["cubemx.check"],
        inputSchema: object({ mode: str("Check depth", { enum: ["quick", "deep"], default: "quick" }) }),
        request: (args) => ({ method: "cubemx.check", params: { mode: args.mode || "quick" } })
    },
    {
        name: "cubemx_start",
        toolset: "cubemx",
        title: "Start background generation",
        description:
            "Start CubeMX code generation in the background; poll cubemx_status with the returned operationId.",
        methods: ["cubemx.start"],
        confirm: true,
        destructive: true,
        inputSchema: object({
            candidatePath: str("Candidate .ioc path"),
            requestId: str("Idempotency key"),
            ...confirmation
        }),
        request: (args) => cubemxRequest("cubemx.start", args)
    },
    {
        name: "cubemx_execute",
        toolset: "cubemx",
        title: "Generate CubeMX code",
        description: "Run CubeMX code generation and wait for it. Requires the user's approval of the returned plan.",
        methods: ["cubemx.execute"],
        confirm: true,
        destructive: true,
        inputSchema: object({
            candidatePath: str("Candidate .ioc path"),
            requestId: str("Idempotency key"),
            ...confirmation
        }),
        request: (args) => cubemxRequest("cubemx.execute", args, 360000),
        // 同步生成不返回 operationId；取消时转发不带 ID 的 cubemx.cancel（取消本工作区正在运行的生成）。
        cancel: () => ({ method: "cubemx.cancel", params: {} })
    },
    {
        name: "cubemx_cancel",
        toolset: "cubemx",
        title: "Cancel CubeMX operation",
        description: "Cancel a running generation or deep check.",
        methods: ["cubemx.cancel"],
        inputSchema: object({ operationId: str("Operation id") }),
        request: (args) => ({ method: "cubemx.cancel", params: args })
    }
];

function cubemxRequest(method, args, timeoutMs = 30000) {
    const params = {};
    if (args.candidatePath) {
        params.candidatePath = path.resolve(args.candidatePath);
        params.candidateHash = candidateHash(params.candidatePath);
    }
    // 同一次工具调用（含确认后的重调）复用同一个 requestId，Bridge 据此去重。
    params.requestId = args.requestId || crypto.randomUUID();
    return { method, params, timeoutMs };
}

// 有意不暴露为 MCP 工具的 Bridge 路由方法（漂移测试要求每个路由要么被映射，要么列在这里）。
const EXCLUDED_METHODS = Object.freeze([]);

function annotations(tool) {
    const observation = tool.methods.every((method) => OBSERVATION_METHODS.has(method)) && !tool.mutates;
    return {
        title: tool.title,
        readOnlyHint: observation,
        destructiveHint: !!tool.destructive,
        idempotentHint: tool.methods.every((method) => READ_ONLY_METHODS.has(method)),
        openWorldHint: false
    };
}

function parseToolsets(value) {
    const names = String(value || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    const selected = names.length ? names : DEFAULT_TOOLSETS;
    if (selected.includes("all")) return [...TOOLSETS];
    return TOOLSETS.filter((name) => selected.includes(name));
}

function toolsFor(toolsets) {
    const enabled = new Set(toolsets);
    return TOOLS.filter((tool) => enabled.has(tool.toolset));
}

function listing(tool) {
    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotations(tool)
    };
}

module.exports = {
    TOOLS,
    TOOLSETS,
    DEFAULT_TOOLSETS,
    EXCLUDED_METHODS,
    annotations,
    parseToolsets,
    toolsFor,
    listing
};
