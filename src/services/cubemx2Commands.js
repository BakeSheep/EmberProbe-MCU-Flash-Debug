"use strict";
const { failure } = require("./cubemxEnvironment");

// CubeMX2 CLI commands an Agent may run, with their options. "string" options take one value, "flag"
// options take none. The project path, backend port and host are always supplied by EmberProbe.
// Excluded on purpose: pack installation, project creation/deletion, middleware and utility enabling
// (may download packs), generation and save (EmberProbe runs them itself), and file-mapping or
// destination settings.
const SP = { "software-project": "string" };
const SWCONFIG = { ...SP, "resource-name": "string", "parameter-path": "string" };
const SHORT = { short: "flag" };
const CLOCK_WRITE = { "flexible-path": "flag", "allow-unlock": "flag" };

const QUERY = {
    "peripherals list": { enabled: "flag", search: "string", details: "flag" },
    "peripherals view": { peripheral: "string", ...SP },
    "peripherals description": { peripheral: "string", cpn: "string" },
    "peripherals resource": { peripheral: "string", ...SP },
    "pinout all-pins": SHORT,
    "pinout assigned-pins": SHORT,
    "pinout pin": { pin: "string", ...SHORT },
    "pinout group": { group: "string", ...SHORT },
    "pinout needs": { instance: "string", ...SHORT },
    "clock get-clocks": { format: "string" },
    "clock get-clock": { id: "string", format: "string" },
    "clock get-clock-items": { ids: "string" },
    "clock list-possible-values": { id: "string" },
    "clock get-clock-constraints": {},
    "clock get-clock-status": {},
    "clock find-clock": { id: "string", type: "string", role: "string", "clocked-instance": "string", exact: "flag" },
    "nvic get-grouping": { values: "flag" },
    "nvic list-interrupts": { ...SP, system: "flag", peripheral: "flag", used: "flag", full: "flag" },
    "nvic get-interrupts-by-instance": { instance: "string" },
    "nvic get-interrupt": { name: "string", priority: "flag", description: "flag", status: "flag" },
    "nvic get-priority": { name: "string", values: "flag" },
    "dma get-allocations": SP,
    "dma list-channels": {
        ...SP,
        "dma-controller": "string",
        "hw-instance": "string",
        used: "string",
        "not-used": "string"
    },
    "dma list-controllers": {},
    "dma list-hw-resources": { ...SP, channel: "string" },
    "dma list-sw-instances": { ...SP, channel: "string" },
    "dma list-configurable-channels": {},
    "exti is-used": { ...SP, "line-id": "string" },
    "exti list-hw-resources": { ...SP, "line-id": "string" },
    "exti list-lines": { ...SP, "hw-instance": "string", used: "flag", "not-used": "flag" },
    "exti list-sw-instances": { ...SP, "line-id": "string" },
    "middleware get-default-middleware": { ...SP, "all-versions": "flag" },
    "middleware get-available-middleware": { ...SP, "all-versions": "flag" },
    "utilities get-default-utilities": { ...SP, "all-versions": "flag" },
    "utilities get-available-utilities": { ...SP, "all-versions": "flag" },
    "sw-config get-parameter-actions": SWCONFIG,
    "sw-config get-parameter-possible-values": { ...SWCONFIG, "use-internal-value": "flag" },
    "sw-config get-parameter-value": { ...SWCONFIG, "use-internal-value": "flag" },
    "sw-config list-parameters": { ...SP, "resource-name": "string" },
    "sw-config list-available-parameters": {
        ...SP,
        "resource-name": "string",
        details: "string",
        "use-internal-value": "flag"
    },
    "sw-config list-configurations": { ...SP, "sw-component-id": "string" },
    "project get-sw-project-list": {},
    "ide-project show-config": {},
    "ide-project status": { ...SP, "only-application-project": "flag" },
    "ide-project list-format": {},
    "ide-project build-target list": {},
    "global-services list": SP
};

const MUTATING = {
    "peripherals enable": { peripheral: "string", ...SP, mode: "string", override: "flag" },
    "peripherals disable": { peripheral: "string", ...SP },
    "pinout assign-signal": { pin: "string", signal: "string" },
    "pinout unassign-signal": { pin: "string", signal: "string" },
    "pinout pin-signal": { pin: "string", signal: "string" },
    "pinout unpin-signal": { pin: "string", signal: "string" },
    "pinout exclude-pin": { pin: "string" },
    "pinout include-pin": { pin: "string" },
    "pinout add-to-group": { pin: "string", group: "string" },
    "pinout remove-from-group": { pin: "string", group: "string" },
    "pinout add-label": { pin: "string", label: "string" },
    "pinout remove-label": { pin: "string", label: "string" },
    "pinout reset-pin": { pin: "string" },
    "clock set-value": {
        id: "string",
        value: "string",
        "fraction-value": "string",
        "fraction-denominator": "string",
        ...CLOCK_WRITE
    },
    "clock set-value-by-hw-instance": { "hw-instance": "string", type: "string", value: "string", ...CLOCK_WRITE },
    "clock set-max-value-by-hw-instance": { "hw-instance": "string", type: "string", ...CLOCK_WRITE },
    "clock set-values": {
        ids: "string",
        values: "string",
        "fraction-values": "string",
        "fraction-denominators": "string",
        ...CLOCK_WRITE
    },
    "clock set-clock-constraints": { id: "string", role: "string", constraints: "string", ...CLOCK_WRITE },
    "clock solver-on-demand": {},
    "nvic set-grouping": { value: "string" },
    "nvic set-interrupts": { ...SP, names: "string", status: "string" },
    "nvic set-priorities": { ...SP, interrupts: "string" },
    "dma bind-resource": { ...SP, channel: "string" },
    "dma unbind-resource": { ...SP, channel: "string", "sw-instance": "string" },
    "middleware disable-middleware": { ...SP, name: "string" },
    "utilities disable-utility": { ...SP, name: "string" },
    "sw-config set-parameter-value": { ...SWCONFIG, value: "string" },
    "sw-config set-multiple-parameters": { ...SP, "resource-name": "string", parameters: "string", force: "flag" },
    "sw-config add-array-element": { ...SWCONFIG, "element-to-add": "string" },
    "sw-config remove-array-element": { ...SWCONFIG, "element-index": "string" },
    "sw-config move-array-element": { ...SWCONFIG, "element-to-move": "string", position: "string" },
    "sw-config reset-configuration": { ...SP, "resource-name": "string" }
};

const MAX_OPERATIONS = 64;
const MAX_VALUE_LENGTH = 4096;

function invalid(message, details) {
    return failure("CUBEMX2_OPERATION_INVALID", message, details);
}

// Build the argument vector for one operation. Values are passed as --name=value so that a value can
// never be read as another option.
function commandArgs(operation, { mutating = false } = {}) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation))
        throw invalid("Each operation must be an object { command, args }");
    const command = typeof operation.command === "string" ? operation.command.trim().replace(/\s+/g, " ") : "";
    const schema = QUERY[command] || (mutating ? MUTATING[command] : undefined);
    if (!schema)
        throw invalid(
            MUTATING[command]
                ? `${command} changes the configuration; use cubemx.prepare with operations`
                : `Unsupported CubeMX2 command: ${command || "(missing)"}`,
            { command, allowed: Object.keys(mutating ? { ...QUERY, ...MUTATING } : QUERY) }
        );
    const args = operation.args === undefined ? {} : operation.args;
    if (!args || typeof args !== "object" || Array.isArray(args))
        throw invalid("Operation args must be an object of option names to values", { command });
    const argv = command.split(" ");
    for (const [name, value] of Object.entries(args)) {
        const type = schema[name];
        if (!type)
            throw invalid(`Unsupported option --${name} for ${command}`, { command, allowed: Object.keys(schema) });
        if (type === "flag") {
            if (typeof value !== "boolean") throw invalid(`--${name} is a flag; use true or false`, { command });
            if (value) argv.push(`--${name}`);
            continue;
        }
        const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
        if (typeof text !== "string" || !text.length || text.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(text))
            throw invalid(`--${name} needs a single-line string or number value`, { command });
        argv.push(`--${name}=${text}`);
    }
    return argv;
}

function operationList(operations, options) {
    if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS)
        throw invalid(`operations must be an array of 1 to ${MAX_OPERATIONS} commands`);
    return operations.map((operation) => ({
        command: commandArgs(operation, options)
            .filter((part) => !part.startsWith("--"))
            .join(" "),
        argv: commandArgs(operation, options)
    }));
}

module.exports = { QUERY, MUTATING, MAX_OPERATIONS, commandArgs, operationList };
