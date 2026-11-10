"use strict";
// Session-level RTT control: one OpenOCD `rtt` command sequence per transaction, on the session's Tcl connection
// under its exclusive lock and the shared per-transaction budget. Addresses, sizes, ports, channels and polling
// intervals are range-checked by rttControlBlock's command builders before anything is sent. Channel data never flows
// through here; the extension host connects to the RTT TCP ports that `rtt server start` opens.

const { commands, parseChannelList } = require("./rttControlBlock");

const { MAX_TARGET_TRANSACTION_MS, targetTransaction, validateTargetRequest } = require("./rttTarget");

const OPERATIONS = ["start", "channels", "serverStart", "serverStop", "stop", "snapshot", "setMode"];
// A transaction is a bounded command list; the controller splits larger channel sets across calls.
const MAX_SERVER_COMMANDS = 16;
// An OpenOCD without the rtt command set cannot gain it by retrying. Other Tcl failures ("control block not found"
// while the firmware initializes) may clear on their own, so the controller may retry them with backoff.
const MISSING_RTT_SUPPORT = /invalid command name|unknown command/i;
// OpenOCD logs the reason for a failed `rtt start` and leaves the Tcl result empty, so the transport's text only names
// the command. A search miss is what that nearly always is.
const SILENT_START_FAILURE = /^OpenOCD command failed/;
// `rtt channels` fails on a channel whose name it cannot read and returns the listing printed so far as the error.
const PARTIAL_CHANNEL_LISTING = /^Up-channels:$/m;

const rttError = (code, message, details) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

function serverCommands(request) {
    const servers = request?.servers;
    if (!Array.isArray(servers) || !servers.length || servers.length > MAX_SERVER_COMMANDS)
        throw rttError(
            "RTT_INVALID_SERVERS",
            `RTT servers must be a list of 1..${MAX_SERVER_COMMANDS} { port, channel } entries`,
            { count: Array.isArray(servers) ? servers.length : 0 }
        );
    // The builder range-checks each port and channel before any command is sent.
    return servers.map((entry) => commands.serverStart(entry?.port, entry?.channel));
}

function portCommands(request) {
    const ports = request?.ports;
    if (!Array.isArray(ports) || !ports.length || ports.length > MAX_SERVER_COMMANDS)
        throw rttError("RTT_INVALID_PORTS", `RTT ports must be a list of 1..${MAX_SERVER_COMMANDS} port numbers`, {
            count: Array.isArray(ports) ? ports.length : 0
        });
    return ports.map((port) => commands.serverStop(port));
}

// Validates the whole request up front and returns the steps to run; the step flagged `channels` carries the
// channel listing, which is parsed into the transaction result.
function buildPlan(request) {
    const operation = request?.operation;
    if (!OPERATIONS.includes(operation))
        throw rttError("RTT_INVALID_OPERATION", `Invalid RTT operation: ${operation}`, {
            operation: operation === undefined ? null : String(operation)
        });
    if (operation === "snapshot" || operation === "setMode") {
        validateTargetRequest(request);
        return { operation, target: true, steps: [] };
    }
    if (operation === "start") {
        if (!request.block || typeof request.block !== "object")
            throw rttError("RTT_INVALID_CONTROL_BLOCK", "RTT start requires a control block { address, size }", {
                block: request.block ?? null
            });
        const interval = commands.pollingInterval(
            request.pollingIntervalMs === undefined ? 10 : request.pollingIntervalMs
        );
        // Stop any existing timer before starting. The bundled OpenOCD registers a timer if the interval is set
        // before start; setting it afterwards also applies it when reusing an already-started session.
        // The listing may still be empty while firmware initializes its up buffers.
        return {
            operation,
            steps: [
                { command: commands.setup(request.block), channels: false },
                { command: commands.stop(), channels: false },
                { command: commands.start(), channels: false },
                { command: interval, channels: false },
                { command: commands.channels(), channels: true }
            ],
            parseChannels: true
        };
    }
    if (operation === "channels")
        return { operation, steps: [{ command: commands.channels(), channels: true }], parseChannels: true };
    if (operation === "serverStart")
        return { operation, steps: serverCommands(request).map((command) => ({ command, channels: false })) };
    if (operation === "serverStop")
        return { operation, steps: portCommands(request).map((command) => ({ command, channels: false })) };
    return { operation, steps: [{ command: commands.stop(), channels: false }] };
}

async function runStep(session, step) {
    try {
        return await session.tcl.sendChecked(step.command);
    } catch (error) {
        if (error?.code !== "OPENOCD_TCL_ERROR") throw error;
        if (step.channels && PARTIAL_CHANNEL_LISTING.test(error.message)) return error.message;
        error.retryable = !MISSING_RTT_SUPPORT.test(error.message);
        if (step.command === commands.start() && SILENT_START_FAILURE.test(error.message))
            error.message = "no control block found in the searched memory";
        throw error;
    }
}

// request: { operation: "start"|"channels"|"serverStart"|"serverStop"|"stop"|"snapshot"|"setMode", block?,
// pollingIntervalMs?, servers?, ports?, channels?, channel?, mode?, expected? }. Snapshot and mode operations use the
// verified ARM32 layout in rttTarget; all operations share this lock and target epoch guard.
async function rttControl(session, request, timeoutMs = 5000) {
    let plan;
    try {
        plan = buildPlan(request);
    } catch (error) {
        error.retryable = false;
        if (request?.operation === "setMode")
            error.details = { ...error.details, operation: "setMode", resultUnknown: false, completed: [] };
        throw error;
    }
    // The budget is checked between OpenOCD commands; each command is bounded by the Tcl RPC timeout.
    const budgetMs = Math.min(Math.max(Number(timeoutMs) || 5000, 1), plan.target ? MAX_TARGET_TRANSACTION_MS : 5000);
    const deadline = session.clock.now() + budgetMs;
    const guard = { targetEpoch: session.targetEpoch, requireSampling: false };
    let acquired = false;
    const output = {};
    let executed = 0;
    const check = () => {
        session._assertReadGuard(guard);
        if (session.clock.now() >= deadline)
            throw Object.assign(new Error(`RTT transaction exceeded its ${budgetMs} ms budget`), {
                code: "LIVE_READ_BUDGET_EXCEEDED",
                details: { maxTransactionMs: budgetMs }
            });
        if (session.stopped || !session.tcl.connected)
            throw rttError("RTT_DISCONNECTED", "OpenOCD Tcl service is not connected");
    };
    try {
        await session._acquireExclusive(deadline);
        acquired = true;
        check();
        if (plan.target)
            return await targetTransaction(session, request, check, async (command) => {
                const response = await session.tcl.sendChecked(command);
                executed++;
                return response;
            });
        let channelText = "";
        for (const step of plan.steps) {
            check();
            const response = await runStep(session, step);
            executed++;
            check();
            if (step.channels) channelText = response;
        }
        if (plan.parseChannels) {
            try {
                output.channels = parseChannelList(channelText);
            } catch (error) {
                error.retryable = false;
                throw error;
            }
        }
        return output;
    } catch (error) {
        if (!error.code) error.code = "RTT_CONTROL_FAILED";
        if (error?.retryable === undefined || request.operation === "setMode") error.retryable = false;
        error.details = {
            ...(request.operation === "setMode" ? { resultUnknown: false, completed: [] } : {}),
            ...error.details,
            operation: plan.operation,
            executed,
            commands: plan.steps.map((s) => s.command)
        };
        throw error;
    } finally {
        if (acquired) session._releaseExclusive();
    }
}

module.exports = { MAX_SERVER_COMMANDS, MISSING_RTT_SUPPORT, OPERATIONS, rttControl };
