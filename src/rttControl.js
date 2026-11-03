"use strict";
// Session-level RTT control: one OpenOCD `rtt` command sequence per transaction, on the session's Tcl connection
// under its exclusive lock and the shared per-transaction budget. Addresses, sizes, ports, channels and polling
// intervals are range-checked by rttControlBlock's command builders before anything is sent. Channel data never flows
// through here; the extension host connects to the RTT TCP ports that `rtt server start` opens.

const { commands, parseChannelList } = require("./rttControlBlock");

const OPERATIONS = ["start", "channels", "serverStart", "serverStop", "stop"];
// A transaction is a bounded command list; the controller splits larger channel sets across calls.
const MAX_SERVER_COMMANDS = 16;
// An OpenOCD without the rtt command set cannot gain it by retrying. Other Tcl failures ("control block not found"
// while the firmware initializes) clear on their own, so the controller may retry them with backoff.
const MISSING_RTT_SUPPORT = /invalid command name|unknown command/i;

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
// channellist response, which is parsed into the transaction result.
function buildPlan(request) {
    const operation = request?.operation;
    if (!OPERATIONS.includes(operation))
        throw rttError("RTT_INVALID_OPERATION", `Invalid RTT operation: ${operation}`, {
            operation: operation === undefined ? null : String(operation)
        });
    if (operation === "start") {
        if (!request.block || typeof request.block !== "object")
            throw rttError("RTT_INVALID_CONTROL_BLOCK", "RTT start requires a control block { address, size }", {
                block: request.block ?? null
            });
        const interval =
            request.pollingIntervalMs === undefined ? [] : [commands.pollingInterval(request.pollingIntervalMs)];
        // channellist runs last: OpenOCD finds the control block by polling, so the list may still be empty here.
        return {
            operation,
            steps: [
                { command: commands.setup(request.block), channels: false },
                ...interval.map((command) => ({ command, channels: false })),
                { command: commands.start(), channels: false },
                { command: commands.channelList(), channels: true }
            ],
            parseChannels: true
        };
    }
    if (operation === "channels")
        return { operation, steps: [{ command: commands.channelList(), channels: true }], parseChannels: true };
    if (operation === "serverStart")
        return { operation, steps: serverCommands(request).map((command) => ({ command, channels: false })) };
    if (operation === "serverStop")
        return { operation, steps: portCommands(request).map((command) => ({ command, channels: false })) };
    return { operation, steps: [{ command: commands.stop(), channels: false }] };
}

// request: { operation: "start"|"channels"|"serverStart"|"serverStop"|"stop", block?, pollingIntervalMs?, servers?,
// ports? }. Returns { channels? }; start and channels parse the channellist, which may be empty until the polling
// finds the control block.
async function rttControl(session, request, timeoutMs = 5000) {
    const plan = buildPlan(request);
    // The budget is checked between OpenOCD commands; each command is bounded by the Tcl RPC timeout.
    const budgetMs = Math.min(Math.max(Number(timeoutMs) || 5000, 1), 5000);
    const deadline = session.clock.now() + budgetMs;
    const guard = { targetEpoch: session.targetEpoch, requireSampling: false };
    await session._acquireExclusive(deadline);
    const output = {};
    let executed = 0;
    const check = () => {
        session._assertReadGuard(guard);
        if (session.clock.now() >= deadline)
            throw Object.assign(new Error(`RTT transaction exceeded its ${budgetMs} ms budget`), {
                code: "LIVE_READ_BUDGET_EXCEEDED",
                details: { maxTransactionMs: budgetMs }
            });
        if (session.stopped || !session.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
    };
    try {
        check();
        let channelText = "";
        for (const step of plan.steps) {
            check();
            let response;
            try {
                response = await session.tcl.sendChecked(step.command);
            } catch (error) {
                if (error?.code === "OPENOCD_TCL_ERROR") error.retryable = !MISSING_RTT_SUPPORT.test(error.message);
                throw error;
            }
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
        if (error?.retryable === undefined) error.retryable = false;
        error.details = {
            ...error.details,
            operation: plan.operation,
            executed,
            commands: plan.steps.map((s) => s.command)
        };
        throw error;
    } finally {
        session._releaseExclusive();
    }
}

module.exports = { MAX_SERVER_COMMANDS, MISSING_RTT_SUPPORT, OPERATIONS, rttControl };
