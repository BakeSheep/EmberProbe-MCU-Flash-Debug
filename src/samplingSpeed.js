"use strict";

const { normalizeAdapterSpeed, probeFamily } = require("../skills/_emberprobe/probe-connection");
const { SYSTEM_CLOCK, STANDALONE_READ_BUDGET_RATIO } = require("./samplingClock");
const { parseMemoryElements } = require("./liveWatchReadPlan");

const SAMPLING_SPEED_LADDERS_KHZ = Object.freeze({
    stlink: Object.freeze([2000, 4000, 8000, 12000, 24000]),
    jlink: Object.freeze([2000, 4000, 8000, 12000, 15000, 20000, 24000]),
    "cmsis-dap": Object.freeze([2000, 4000, 8000, 12000, 16000, 20000]),
    ftdi: Object.freeze([2000, 4000, 8000, 12000, 15000]),
    xds110: Object.freeze([2000, 4000, 8000, 12000, 14000]),
    nulink: Object.freeze([2000, 4000, 8000, 12000])
});
const DEFAULT_SPEED_LADDER_KHZ = Object.freeze([2000, 4000, 8000, 12000]);
const ALLOWED_TARGETS = new Set(["cortex_m", "hla_target"]);
const ALLOWED_TRANSPORTS = new Set(["swd", "hla_swd", "dapdirect_swd"]);
const CPUID_ADDRESS = 0xe000ed00;
const BENCH_RAM_WORDS = 128;
const BENCH_MIN_RAM_WORDS = 16;
const BENCH_CPUID_SCATTER_SEGMENTS = 32;
const BENCH_CPUID_BATCH_COUNT = 8;
const BENCH_CPUID_SINGLE_COUNT = 4;
const DEFAULT_BUDGET_MS = 600;
const TCP_BUDGET_MS = 1200;
const STEP_PROBE_TIMEOUT_MS = 500;
const TCP_STEP_PROBE_TIMEOUT_MS = 1000;
const IMPROVEMENT_RATIO = 0.05;
const IMPROVEMENT_MIN_SAVED_MS = 0.15;
const SLOWDOWN_RATIO = 1.1;
const MAX_PLATEAU_STEPS = 2;
const MIN_MANUAL_SAMPLING_SPEED_KHZ = 1000;
const MAX_MANUAL_SAMPLING_SPEED_KHZ = 20000;
const MANUAL_SAMPLING_SPEED_STEP_KHZ = 1000;
const DEFAULT_MANUAL_SAMPLING_SPEED_KHZ = 2000;
const TUNING_BUDGET_EXHAUSTED = "SAMPLING_SPEED_BUDGET_EXHAUSTED";

const ELIGIBILITY_QUERY_CMD =
    "set _ep_t [target current]; " +
    'set _ep_rd [expr {[llength [info commands read_memory]] ? "read_memory" : "ocd_read_memory"}]; ' +
    'join [list [$_ep_t cget -type] [transport select] $_ep_rd] "\\n"';

/** @param {Record<string, any>} [options] */
function configuredSamplingSpeedKhz(options = {}) {
    return (
        normalizeAdapterSpeed(options.samplingAdapterSpeedKhz) || normalizeAdapterSpeed(options.adapterSpeedKhz) || 0
    );
}

/** @param {Record<string, any>} [options] */
function samplingSpeedLadder(options = {}) {
    return SAMPLING_SPEED_LADDERS_KHZ[probeFamily(options)] || DEFAULT_SPEED_LADDER_KHZ;
}

function clampManualSamplingSpeedKhz(value, fallback = DEFAULT_MANUAL_SAMPLING_SPEED_KHZ) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    const clamped = Math.min(MAX_MANUAL_SAMPLING_SPEED_KHZ, Math.max(MIN_MANUAL_SAMPLING_SPEED_KHZ, num));
    return Math.round(clamped / MANUAL_SAMPLING_SPEED_STEP_KHZ) * MANUAL_SAMPLING_SPEED_STEP_KHZ;
}

function isValidManualSamplingSpeedKhz(value) {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_MANUAL_SAMPLING_SPEED_KHZ &&
        value <= MAX_MANUAL_SAMPLING_SPEED_KHZ &&
        value % MANUAL_SAMPLING_SPEED_STEP_KHZ === 0
    );
}

function parseAdapterSpeedKhz(text) {
    const match = String(text || "").match(/(\d+)\s*kHz/i);
    if (!match) return 0;
    const khz = Number(match[1]);
    return Number.isInteger(khz) && khz > 0 ? khz : 0;
}

function u32ToLittleEndianHex(word) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(word >>> 0, 0);
    return buffer.toString("hex");
}

function selectBenchmarkRamBlock(watch, ramSectionRanges) {
    if (!Array.isArray(watch) || !Array.isArray(ramSectionRanges) || !ramSectionRanges.length) return null;
    for (const item of watch) {
        if (!item || item.runtimeLayout) continue;
        const address = Number(item.address);
        const size = Number(item.size);
        if (!Number.isInteger(address) || !Number.isInteger(size) || address < 0 || size <= 0) continue;
        const end = address + size;
        const range = ramSectionRanges.find((entry) => address >= entry.start && end <= entry.end);
        if (!range) continue;
        const alignedStart = Math.ceil(range.start / 4) * 4;
        const alignedEnd = Math.floor(range.end / 4) * 4;
        const availableWords = Math.floor((alignedEnd - alignedStart) / 4);
        if (availableWords < BENCH_MIN_RAM_WORDS) continue;
        const words = Math.min(BENCH_RAM_WORDS, availableWords);
        const maxAddr = alignedEnd - words * 4;
        const windowAddr = Math.min(maxAddr, Math.max(alignedStart, Math.floor(address / 4) * 4));
        return { address: windowAddr >>> 0, words };
    }
    return null;
}

function median(values) {
    const valid = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value) && value > 0);
    if (!valid.length) return null;
    valid.sort((a, b) => a - b);
    const mid = Math.floor(valid.length / 2);
    return valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function isMeaningfulImprovement(bestMs, candidateMs) {
    if (!(bestMs > 0) || !(candidateMs > 0) || candidateMs >= bestMs) return false;
    const savedMs = bestMs - candidateMs;
    const gain = savedMs / bestMs;
    return gain >= IMPROVEMENT_RATIO && savedMs >= IMPROVEMENT_MIN_SAVED_MS;
}

function isSignificantSlowdown(bestMs, candidateMs) {
    return bestMs > 0 && candidateMs > 0 && candidateMs > bestMs * SLOWDOWN_RATIO;
}

function midpointCandidateKhz(lowKhz, highKhz) {
    if (!(highKhz - lowKhz >= 2000)) return 0;
    const mid = Math.round((lowKhz + highKhz) / 2 / 500) * 500;
    return mid > lowKhz && mid < highKhz ? mid : 0;
}

function buildBenchmarkPlan({ scatterReads, readCmd, ramBlock, expectedCpuid, batchUnsupported }) {
    const cpuidHex = `0x${CPUID_ADDRESS.toString(16)}`;
    const expectedHex = u32ToLittleEndianHex(expectedCpuid);
    if (ramBlock) {
        const ramHex = `0x${(ramBlock.address >>> 0).toString(16)}`;
        if (scatterReads) {
            return {
                mode: "ram-scatter",
                ramBlock,
                expectedCpuid: expectedCpuid >>> 0,
                expectedHex,
                expectedWords: ramBlock.words,
                commands: [
                    `emberprobe_read_scatter {${cpuidHex} 32 1} {${ramHex} 32 ${ramBlock.words}} {${cpuidHex} 32 1}`
                ]
            };
        }
        if (!batchUnsupported) {
            return {
                mode: "ram-batch",
                ramBlock,
                expectedCpuid: expectedCpuid >>> 0,
                expectedWords: ramBlock.words,
                commands: [
                    `join [list [${readCmd} ${cpuidHex} 32 1] [${readCmd} ${ramHex} 32 ${ramBlock.words}] [${readCmd} ${cpuidHex} 32 1]] "\\n"`
                ]
            };
        }
        return {
            mode: "ram-single",
            ramBlock,
            expectedCpuid: expectedCpuid >>> 0,
            expectedWords: ramBlock.words,
            commands: [
                `${readCmd} ${cpuidHex} 32 1`,
                `${readCmd} ${ramHex} 32 ${ramBlock.words}`,
                `${readCmd} ${cpuidHex} 32 1`
            ]
        };
    }
    if (scatterReads) {
        const segments = Array.from({ length: BENCH_CPUID_SCATTER_SEGMENTS }, () => `{${cpuidHex} 32 1}`);
        return {
            mode: "cpuid-scatter",
            ramBlock: null,
            expectedCpuid: expectedCpuid >>> 0,
            expectedHex,
            segmentCount: BENCH_CPUID_SCATTER_SEGMENTS,
            commands: [`emberprobe_read_scatter ${segments.join(" ")}`]
        };
    }
    if (!batchUnsupported) {
        const calls = Array.from({ length: BENCH_CPUID_BATCH_COUNT }, () => `[${readCmd} ${cpuidHex} 32 1]`);
        return {
            mode: "cpuid-batch",
            ramBlock: null,
            expectedCpuid: expectedCpuid >>> 0,
            segmentCount: BENCH_CPUID_BATCH_COUNT,
            commands: [`join [list ${calls.join(" ")}] "\\n"`]
        };
    }
    return {
        mode: "cpuid-single",
        ramBlock: null,
        expectedCpuid: expectedCpuid >>> 0,
        commands: Array.from({ length: BENCH_CPUID_SINGLE_COUNT }, () => `${readCmd} ${cpuidHex} 32 1`)
    };
}

function verifyWordElement(text, expectedCpuid) {
    const values = parseMemoryElements(text, 32);
    return values.length === 1 && values[0] === expectedCpuid;
}

function verifyBenchmarkReply(plan, reply) {
    if (!plan) return false;
    if (plan.mode === "ram-scatter" || plan.mode === "cpuid-scatter") {
        const text = Array.isArray(reply) ? (reply.length === 1 ? reply[0] : "") : reply;
        const lines = String(text ?? "").split(/\r?\n/);
        if (plan.mode === "ram-scatter") {
            return (
                lines.length === 3 &&
                lines[0] === plan.expectedHex &&
                lines[2] === plan.expectedHex &&
                lines[1].length === plan.expectedWords * 8 &&
                /^[0-9a-f]+$/.test(lines[1])
            );
        }
        return lines.length === plan.segmentCount && lines.every((line) => line === plan.expectedHex);
    }
    if (plan.mode === "ram-batch" || plan.mode === "cpuid-batch") {
        const text = Array.isArray(reply) ? (reply.length === 1 ? reply[0] : "") : reply;
        const lines = String(text ?? "").split(/\r?\n/);
        if (plan.mode === "ram-batch") {
            return (
                lines.length === 3 &&
                verifyWordElement(lines[0], plan.expectedCpuid) &&
                verifyWordElement(lines[2], plan.expectedCpuid) &&
                parseMemoryElements(lines[1], 32).length === plan.expectedWords
            );
        }
        return lines.length === plan.segmentCount && lines.every((line) => verifyWordElement(line, plan.expectedCpuid));
    }
    const replies = Array.isArray(reply) ? reply : [];
    if (replies.length !== plan.commands.length) return false;
    if (plan.mode === "ram-single") {
        return (
            verifyWordElement(replies[0], plan.expectedCpuid) &&
            verifyWordElement(replies[2], plan.expectedCpuid) &&
            parseMemoryElements(replies[1], 32).length === plan.expectedWords
        );
    }
    return replies.every((entry) => verifyWordElement(entry, plan.expectedCpuid));
}

function isBatchSyntaxError(error) {
    return /(?:invalid command name|unknown command)\s+["']?(?:join|list)/i.test(String(error?.message || ""));
}

const LINK_DIAGNOSTIC_CODES = new Set([
    "OPENOCD_MEMORY_RESPONSE_ERROR",
    "LIVE_MEMORY_UNAVAILABLE",
    "LIVE_MEMORY_UNSUPPORTED",
    "LIVE_TARGET_POLL_FAILED"
]);

function resetSessionMetrics(session, frameDurationMs = null, retimePlan = true) {
    session._warmUp(frameDurationMs, retimePlan);
    session._pollFailureSince = null;
    session._pollFailureCount = 0;
}

async function ensureConnected(session, timeoutMs) {
    if (session.stopped || session.connectionFailed) return false;
    try {
        if (!session.tcl.connected) await session._ensureTclConnected(timeoutMs);
    } catch {
        return false;
    }
    return !session.stopped && !session.connectionFailed && !!session.tcl.connected;
}

class SamplingSpeedTuner {
    /** @param {{ options?: Record<string, any>, mode?: string, clock?: any }} [config] */
    constructor({ options = {}, mode = "standalone", clock = SYSTEM_CLOCK } = {}) {
        /** @type {Record<string, any>} */
        this.options = options || {};
        this.mode = mode === "debug" ? "debug" : "standalone";
        this.clock = { ...SYSTEM_CLOCK, ...clock };
        this.configuredSpeedKhz = configuredSamplingSpeedKhz(this.options);
        if (this.mode === "debug") {
            this.state = "disabled";
            this.reason = "debug_mode";
            this.effectiveKhz = null;
            this.requestedKhz = null;
        } else if (this.configuredSpeedKhz > 0) {
            this.state = "disabled";
            this.reason = "explicit_config";
            this.effectiveKhz = this.configuredSpeedKhz;
            this.requestedKhz = this.configuredSpeedKhz;
        } else if (!this.hasSamplingIntent()) {
            this.state = "disabled";
            this.reason = "disabled";
            this.effectiveKhz = null;
            this.requestedKhz = null;
        } else {
            this.state = "pending";
            this.reason = null;
            this.effectiveKhz = null;
            this.requestedKhz = null;
        }
        this.probingActive = false;
        this.baseKhz = null;
        this.testedSteps = [];
        this.verifiedChain = [];
        this._chainIndex = -1;
        this._lastReduced = null;
        this._hardMaxKhz = null;
        this._tentativeError = null;
        this._recheckAfterFirstCycle = false;
        this._tuned = false;
        this._tunedFrameBudgetMs = null;
        this._tunedWatch = null;
        this._runtimeFailures = 0;
        this._fallbackCount = 0;
        this._pendingStepDown = false;
    }

    hasSamplingIntent() {
        return this.options.adaptiveAdapterSpeed === "sampling" || this.options.adaptiveAdapterSpeed === "agent";
    }

    isEnabled() {
        return this.mode === "standalone" && this.configuredSpeedKhz === 0 && this.hasSamplingIntent();
    }

    shouldTuneAtStart(watch) {
        return (
            this.isEnabled() &&
            !this._tuned &&
            (this.options.adaptiveAdapterSpeed === "agent" || (Array.isArray(watch) && watch.length > 0))
        );
    }

    _frameBudgetMs(session) {
        if (this.options.adaptiveAdapterSpeed !== "sampling" || session.unlimitedActive) return null;
        return session.targetIntervalMs * STANDALONE_READ_BUDGET_RATIO;
    }

    shouldTuneBeforeTick(session) {
        const frameBudgetMs = this._frameBudgetMs(session);
        return (
            this.isEnabled() &&
            session._startCompleted === true &&
            session.watch.length > 0 &&
            (!this._tuned ||
                (!!this._baselineInfo &&
                    !this._fallbackCount &&
                    (this._tunedFrameBudgetMs !== frameBudgetMs ||
                        (frameBudgetMs !== null && this._tunedWatch !== session.primarySamplingItems))))
        );
    }

    shouldRecheckAfterFirstCycle() {
        return this.isEnabled() && this._recheckAfterFirstCycle;
    }

    observeLog(line) {
        const match = String(line || "").match(/Reduced speed from (\d+) kHz to (\d+) kHz/i);
        if (!match) return;
        const from = Number(match[1]);
        const to = Number(match[2]);
        if (!Number.isInteger(from) || !Number.isInteger(to) || to <= 0) return;
        this._lastReduced = { from, to };
        this._hardMaxKhz = this._hardMaxKhz === null ? to : Math.min(this._hardMaxKhz, to);
    }

    noteTentativeError(line) {
        if (!this.probingActive) return false;
        this._tentativeError = String(line || "");
        return true;
    }

    handleTentativeLog(line) {
        if (!this.probingActive) return false;
        const text = String(line || "");
        if (
            /target communication error|\bPolling failed\b|\bError\s*:/i.test(text) ||
            (!/\bInfo\s*:/i.test(text) && /failed|unable to|no device found|libusb|in use|denied|timed out/i.test(text))
        ) {
            return this.noteTentativeError(text);
        }
        return false;
    }

    needsPreCycle(session) {
        return this.hasPendingStepDown() || this.shouldTuneBeforeTick(session);
    }

    async runPreCycle(session) {
        const previousKhz = this.effectiveKhz;
        const steppingDown = this.hasPendingStepDown();
        const frameDurationMs = steppingDown ? null : await this.tune(session);
        const changed = steppingDown ? await this.stepDown(session) : previousKhz !== this.effectiveKhz;
        if (changed || frameDurationMs != null) resetSessionMetrics(session, frameDurationMs, false);
        if (!steppingDown || changed) {
            if (session.samplingEnabled) session._status?.({ key: "sb.sampling" });
        }
        return (
            !session.samplingEnabled ||
            session.stopped ||
            session.connectionFailed ||
            session._hostHold ||
            !session.tcl.connected ||
            !session.watch.length
        );
    }

    needsStepDown(session, epoch, readSuccess) {
        return (
            epoch === session.sampleEpoch &&
            session.samplingEnabled &&
            !session.connectionFailed &&
            !session.stopped &&
            this.recordCycleOutcome(readSuccess)
        );
    }

    async finishCycle(session, tunedInCycle, frameDurationMs) {
        try {
            const stepped = !tunedInCycle && (await this.stepDown(session));
            if (tunedInCycle || stepped) {
                resetSessionMetrics(session, frameDurationMs);
                if (session.samplingEnabled) session._status?.({ key: "sb.sampling" });
            }
        } catch {
            /* Keep caller's lock release intact if a step-down fails unexpectedly. */
        }
    }

    _resolveEffectiveKhz(requestedKhz, reportedKhz) {
        if (this._lastReduced && this._lastReduced.from === requestedKhz) return this._lastReduced.to;
        const base = reportedKhz > 0 ? reportedKhz : requestedKhz;
        return this._hardMaxKhz !== null ? Math.min(base, this._hardMaxKhz) : base;
    }

    _stepTimeoutMs() {
        return this.options.backendKind === "tcp" ? TCP_STEP_PROBE_TIMEOUT_MS : STEP_PROBE_TIMEOUT_MS;
    }

    _budgetMs() {
        return this.options.backendKind === "tcp" ? TCP_BUDGET_MS : DEFAULT_BUDGET_MS;
    }

    async _probeBefore(session, cmd, deadline) {
        const budgetError = () =>
            Object.assign(new Error("Sampling clock tuning budget exhausted"), {
                code: TUNING_BUDGET_EXHAUSTED
            });
        const remainingMs = Math.floor(deadline - this.clock.monotonicMs());
        if (remainingMs <= 0) throw budgetError();
        let reply;
        try {
            reply = await session.tcl.probe(cmd, Math.min(this._stepTimeoutMs(), remainingMs));
        } catch (error) {
            if (this.clock.monotonicMs() >= deadline) throw budgetError();
            throw error;
        }
        if (this.clock.monotonicMs() >= deadline) throw budgetError();
        return reply;
    }

    _abort(session, error) {
        if (session.stopped || session.connectionFailed) return;
        this.state = "failed";
        this.reason = "restore_failed";
        this.effectiveKhz = null;
        this.requestedKhz = null;
        session._abortConnection(error);
    }

    async _recoverConnection(session) {
        if (!(await ensureConnected(session, this._budgetMs())))
            this._abort(
                session,
                Object.assign(new Error("Could not reconnect OpenOCD Tcl after sampling clock tuning"), {
                    code: "SAMPLING_CLOCK_RECONNECT_FAILED",
                    i18nKey: "live.connectionClosed"
                })
            );
    }

    async _probeEligibility(session, deadline, allowRecheck) {
        this._tentativeError = null;
        this.probingActive = true;
        try {
            const response = await this._probeBefore(session, ELIGIBILITY_QUERY_CMD, deadline);
            const [targetType, transport, readCmd, extra] = String(response || "")
                .trim()
                .split(/\r?\n/);
            if (extra !== undefined || !["read_memory", "ocd_read_memory"].includes(readCmd)) {
                this.state = "ineligible";
                this.reason = "invalid_baseline";
                return null;
            }
            if (!ALLOWED_TARGETS.has(targetType) || !ALLOWED_TRANSPORTS.has(transport)) {
                this.state = "ineligible";
                this.reason = "unsupported_target_or_transport";
                return null;
            }
            const baseKhz = parseAdapterSpeedKhz(await this._probeBefore(session, "adapter speed", deadline));
            const cpuid = await this._probeBefore(session, `${readCmd} 0x${CPUID_ADDRESS.toString(16)} 32 1`, deadline);
            const values = parseMemoryElements(cpuid, 32);
            const expectedCpuid = values.length === 1 ? values[0] : 0;
            if (this._tentativeError || !baseKhz || !expectedCpuid || expectedCpuid === 0xffffffff) {
                this.state = "ineligible";
                this.reason = "invalid_baseline";
                return null;
            }
            return { baseKhz, expectedCpuid, readCmd };
        } catch (error) {
            if (!session.stopped && !session.connectionFailed) {
                if (allowRecheck && /not examined/i.test(String(error?.message || ""))) {
                    this._recheckAfterFirstCycle = true;
                } else {
                    this.state = "ineligible";
                    this.reason = error.code === TUNING_BUDGET_EXHAUSTED ? "budget_reached" : "baseline_read_failed";
                }
                await this._recoverConnection(session);
            }
            return null;
        } finally {
            this.probingActive = false;
        }
    }

    async _sendBenchmark(session, plan, deadline) {
        if (plan.watch) return this._sendFrameBenchmark(session, plan, deadline);
        const replies = [];
        for (const cmd of plan.commands) {
            this._tentativeError = null;
            try {
                const reply = await this._probeBefore(session, cmd, deadline);
                if (this._tentativeError || session.stopped || session.connectionFailed) {
                    return { ok: false, batchUnsupported: false };
                }
                replies.push(reply);
            } catch (error) {
                if (error.code === TUNING_BUDGET_EXHAUSTED) throw error;
                return { ok: false, batchUnsupported: isBatchSyntaxError(error) };
            }
        }
        return { ok: verifyBenchmarkReply(plan, replies), batchUnsupported: false };
    }

    async _sendFrameBenchmark(session, { watch, epoch, expectedCpuid, readCmd }, deadline) {
        if (epoch !== session.sampleEpoch || watch !== session.primarySamplingItems) return { ok: false };
        this._tentativeError = null;
        const guard = {
            epoch,
            probe: (cmd) => {
                session._assertReadGuard(guard);
                return this._probeBefore(session, cmd, deadline);
            }
        };
        try {
            const reply = await guard.probe(`${readCmd} 0x${CPUID_ADDRESS.toString(16)} 32 1`);
            if (this._tentativeError || !verifyWordElement(reply, expectedCpuid)) return { ok: false };
            const start = this.clock.monotonicMs();
            const { samples, ok } = await session._readItems(watch, this.clock.now(), guard);
            return {
                ok:
                    epoch === session.sampleEpoch &&
                    ok === watch.length &&
                    !this._tentativeError &&
                    samples.every((sample) => !LINK_DIAGNOSTIC_CODES.has(sample.diagnostic?.code)),
                durationMs: this.clock.monotonicMs() - start
            };
        } catch (error) {
            if (error.code === TUNING_BUDGET_EXHAUSTED) throw error;
            return { ok: false };
        }
    }

    async _measureStep(session, plan, deadline, timedCount = null) {
        const warmStart = this.clock.monotonicMs();
        const warmup = await this._sendBenchmark(session, plan, deadline);
        const warmMs = this.clock.monotonicMs() - warmStart;
        if (!warmup.ok) return { ok: false, medianMs: null, batchUnsupported: warmup.batchUnsupported };
        const count = timedCount ?? (warmMs > 60 ? 2 : 3);
        const durations = [];
        for (let i = 0; i < count; i++) {
            const t0 = this.clock.monotonicMs();
            const res = await this._sendBenchmark(session, plan, deadline);
            const dt = this.clock.monotonicMs() - t0;
            if (!res.ok) return { ok: false, medianMs: null, batchUnsupported: res.batchUnsupported };
            durations.push(res.durationMs ?? dt);
        }
        const med = median(durations);
        const frameDurationMs = plan.watch ? durations.reduce((sum, duration) => sum + duration, 0) / count : null;
        return med === null
            ? { ok: false, medianMs: null, batchUnsupported: false }
            : { ok: true, medianMs: med, frameDurationMs, timedCount: count, batchUnsupported: false };
    }

    async _measureBaseline(session, expectedCpuid, readCmd, deadline, frame) {
        this.probingActive = true;
        try {
            if (frame) {
                const plan = { ...frame, expectedCpuid, readCmd };
                const res = await this._measureStep(session, plan, deadline);
                return res.ok ? { ...res, plan } : null;
            }
            const initialRamBlock = selectBenchmarkRamBlock(session.watch, session.ramSectionRanges);
            const attempts = initialRamBlock ? [initialRamBlock, null] : [null];
            for (const ramBlock of attempts) {
                if (session.stopped || session.connectionFailed || !session.tcl.connected) return null;
                let plan = buildBenchmarkPlan({
                    scatterReads: !!session.scatterReads,
                    readCmd,
                    ramBlock,
                    expectedCpuid,
                    batchUnsupported: !!session._batchUnsupported
                });
                let res = await this._measureStep(session, plan, deadline);
                if (!res.ok && res.batchUnsupported) {
                    session._batchUnsupported = true;
                    plan = buildBenchmarkPlan({
                        scatterReads: !!session.scatterReads,
                        readCmd,
                        ramBlock,
                        expectedCpuid,
                        batchUnsupported: true
                    });
                    res = await this._measureStep(session, plan, deadline);
                }
                if (res.ok) return { ...res, plan };
            }
            return null;
        } finally {
            this.probingActive = false;
        }
    }

    async _restoreSpeed(session, targetKhz, { expectedCpuid, readCmd }, deadline) {
        const wasProbing = this.probingActive;
        this.probingActive = true;
        try {
            const remainingMs = Math.floor(deadline - this.clock.monotonicMs());
            if (remainingMs <= 0 || !(await ensureConnected(session, remainingMs))) return false;
            this._lastReduced = null;
            this._tentativeError = null;
            const speed = parseAdapterSpeedKhz(
                await this._probeBefore(session, `adapter speed ${targetKhz}`, deadline)
            );
            if (!speed || this._resolveEffectiveKhz(targetKhz, speed) !== targetKhz) return false;
            this._tentativeError = null;
            const reply = await this._probeBefore(session, `${readCmd} 0x${CPUID_ADDRESS.toString(16)} 32 1`, deadline);
            return !this._tentativeError && verifyWordElement(reply, expectedCpuid);
        } catch {
            return false;
        } finally {
            this.probingActive = wasProbing;
        }
    }

    async _probeCandidate(session, khz, plan, deadline, timedCount, testedEffective) {
        const wasProbing = this.probingActive;
        this._lastReduced = null;
        this._tentativeError = null;
        this.probingActive = true;
        try {
            let speedReply;
            try {
                speedReply = await this._probeBefore(session, `adapter speed ${khz}`, deadline);
            } catch (error) {
                if (error.code === TUNING_BUDGET_EXHAUSTED) throw error;
                return { status: "rejected" };
            }
            const reportedKhz = parseAdapterSpeedKhz(speedReply);
            if (!reportedKhz || this._tentativeError) return { status: "rejected" };
            let effectiveKhz = this._resolveEffectiveKhz(khz, reportedKhz);
            if (testedEffective.has(effectiveKhz)) {
                return { status: "duplicate", reportedKhz, effectiveKhz };
            }
            const step = await this._measureStep(session, plan, deadline, timedCount);
            effectiveKhz = this._resolveEffectiveKhz(khz, reportedKhz);
            return {
                status: step.ok ? "ok" : "failed",
                reportedKhz,
                effectiveKhz,
                medianMs: step.medianMs,
                frameDurationMs: step.frameDurationMs
            };
        } finally {
            this.probingActive = wasProbing;
        }
    }

    _abortUnverifiedSpeed(session) {
        this._abort(
            session,
            Object.assign(new Error("Could not restore a verified sampling clock"), {
                code: "SAMPLING_CLOCK_RESTORE_FAILED",
                i18nKey: "live.connectionClosed"
            })
        );
    }

    async _returnToBaseline(session, baselineInfo, deadline) {
        const previousKhz = this.effectiveKhz;
        if (previousKhz === null || previousKhz === baselineInfo.baseKhz) return true;
        if (await this._restoreSpeed(session, baselineInfo.baseKhz, baselineInfo, deadline)) return true;
        const recoveryDeadline = this.clock.monotonicMs() + this._budgetMs();
        if (await this._restoreSpeed(session, previousKhz, baselineInfo, recoveryDeadline)) {
            this.reason = "restore_failed";
        } else {
            this._abortUnverifiedSpeed(session);
        }
        return false;
    }

    async tune(session) {
        if (!this.isEnabled() || session.stopped || session.connectionFailed || !session.tcl.connected) return;
        const allowRecheck = !this._recheckAfterFirstCycle;
        this._tuned = true;
        this._recheckAfterFirstCycle = false;
        const frameBudgetMs = this._frameBudgetMs(session);
        this._tunedFrameBudgetMs = frameBudgetMs;
        this._tunedWatch = session.primarySamplingItems;
        const frame = frameBudgetMs === null ? null : { watch: this._tunedWatch, epoch: session.sampleEpoch };
        const deadline = this.clock.monotonicMs() + this._budgetMs();

        const baselineInfo = this._baselineInfo ?? (await this._probeEligibility(session, deadline, allowRecheck));
        if (!baselineInfo || session.stopped || session.connectionFailed) return;
        if (!(await this._returnToBaseline(session, baselineInfo, deadline))) return;
        if (session.stopped || session.connectionFailed) return;
        const { baseKhz, expectedCpuid, readCmd } = baselineInfo;
        this._baselineInfo = baselineInfo;
        this.baseKhz = baseKhz;
        this.effectiveKhz = baseKhz;
        this.requestedKhz = baseKhz;
        this.verifiedChain = [baseKhz];
        this._chainIndex = 0;
        this._runtimeFailures = 0;
        this.testedSteps = [];

        const primary = samplingSpeedLadder(this.options).filter((k) => k > baseKhz);
        if (!primary.length) {
            this.state = "unchanged";
            this.reason = "at_ceiling";
            return;
        }

        let baseline;
        try {
            baseline = await this._measureBaseline(session, expectedCpuid, readCmd, deadline, frame);
        } catch (error) {
            if (error.code !== TUNING_BUDGET_EXHAUSTED) throw error;
            this.state = "unchanged";
            this.reason = "budget_reached";
            await this._recoverConnection(session);
            return;
        }
        if (frame && frame.epoch !== session.sampleEpoch) {
            this._tunedWatch = null;
            this.state = "unchanged";
            this.reason = "plan_changed";
            await this._recoverConnection(session);
            return;
        }
        if (!baseline) {
            this.state = "ineligible";
            this.reason = "baseline_read_failed";
            await this._recoverConnection(session);
            return;
        }
        if (frame && baseline.frameDurationMs <= frameBudgetMs) {
            this.state = "unchanged";
            this.reason = "target_reached";
            return baseline.frameDurationMs;
        }

        let best = {
            requestedKhz: baseKhz,
            effectiveKhz: baseKhz,
            medianMs: baseline.medianMs,
            frameDurationMs: baseline.frameDurationMs
        };
        const verifiedSteps = [best];
        const testedEffective = new Set([baseKhz]);
        const attemptedRequested = new Set([baseKhz]);
        let queue = primary.map((khz) => ({ khz, refined: false }));
        let lastGoodRequestedKhz = baseKhz;
        let currentEffectiveKhz = baseKhz;
        let currentReportedKhz = baseKhz;
        let plateauCount = 0;
        let stopReason = "";

        this.probingActive = true;
        try {
            while (queue.length) {
                if (session.stopped || session.connectionFailed) return;
                if (frame && frame.epoch !== session.sampleEpoch) {
                    this._tunedWatch = null;
                    stopReason = "plan_changed";
                    break;
                }
                if (deadline - this.clock.monotonicMs() < 1) {
                    stopReason = "budget_reached";
                    break;
                }
                const entry = queue.shift();
                const khz = entry.khz;
                if (attemptedRequested.has(khz)) continue;
                if (this._hardMaxKhz !== null && khz > this._hardMaxKhz && testedEffective.has(this._hardMaxKhz)) {
                    stopReason = "driver_clamped";
                    break;
                }
                attemptedRequested.add(khz);

                let probe;
                try {
                    probe = await this._probeCandidate(
                        session,
                        khz,
                        baseline.plan,
                        deadline,
                        baseline.timedCount,
                        testedEffective
                    );
                } catch (error) {
                    if (error.code !== TUNING_BUDGET_EXHAUSTED) throw error;
                    currentEffectiveKhz = null;
                    stopReason = "budget_reached";
                    break;
                }
                if (session.stopped || session.connectionFailed) return;
                if (frame && frame.epoch !== session.sampleEpoch) {
                    this._tunedWatch = null;
                    currentEffectiveKhz = null;
                    stopReason = "plan_changed";
                    break;
                }
                if (probe.status === "duplicate") {
                    currentReportedKhz = probe.reportedKhz;
                    currentEffectiveKhz = probe.effectiveKhz;
                    if (this._hardMaxKhz !== null && khz >= this._hardMaxKhz) {
                        stopReason = "driver_clamped";
                        break;
                    }
                    continue;
                }
                const rejected = probe.status === "rejected";
                const stepEffective = rejected ? khz : probe.effectiveKhz;
                currentReportedKhz = rejected ? currentReportedKhz : probe.reportedKhz;
                currentEffectiveKhz = rejected ? null : probe.effectiveKhz;
                this.testedSteps.push({
                    requestedKhz: khz,
                    effectiveKhz: stepEffective,
                    medianMs: rejected ? null : probe.medianMs,
                    ok: probe.status === "ok"
                });
                if (rejected || probe.status === "failed") {
                    // A failed benchmark can leave the adapter at an unverified speed even if the setter returned an error.
                    currentEffectiveKhz = null;
                    stopReason = rejected ? "driver_rejected" : "stability_limit";
                    if (!entry.refined) {
                        const mid = midpointCandidateKhz(lastGoodRequestedKhz, khz);
                        if (mid && !attemptedRequested.has(mid)) {
                            if (await this._restoreSpeed(session, best.effectiveKhz, baselineInfo, deadline)) {
                                currentEffectiveKhz = best.effectiveKhz;
                                currentReportedKhz = best.effectiveKhz;
                                queue = [{ khz: mid, refined: true }];
                                stopReason = "";
                                continue;
                            }
                            stopReason = deadline - this.clock.monotonicMs() < 1 ? "budget_reached" : "restore_failed";
                        }
                    }
                    break;
                }

                lastGoodRequestedKhz = khz;
                if (testedEffective.has(probe.effectiveKhz)) {
                    stopReason = "driver_clamped";
                    break;
                }
                testedEffective.add(probe.effectiveKhz);
                const previous = verifiedSteps.at(-1);
                const step = {
                    requestedKhz: khz,
                    effectiveKhz: probe.effectiveKhz,
                    medianMs: probe.medianMs,
                    frameDurationMs: probe.frameDurationMs
                };
                verifiedSteps.push(step);
                if (frame && step.frameDurationMs <= frameBudgetMs) {
                    best = step;
                    stopReason = "target_reached";
                    break;
                }
                if (
                    isMeaningfulImprovement(best.medianMs, step.medianMs) &&
                    isMeaningfulImprovement(previous.medianMs, step.medianMs)
                ) {
                    best = step;
                    plateauCount = 0;
                } else if (isSignificantSlowdown(best.medianMs, probe.medianMs)) {
                    stopReason = "slowdown";
                    break;
                } else if (++plateauCount >= MAX_PLATEAU_STEPS) {
                    stopReason = "plateau";
                    break;
                }
                if (this._hardMaxKhz !== null && probe.effectiveKhz >= this._hardMaxKhz) {
                    stopReason = "driver_clamped";
                    break;
                }
            }

            if (session.stopped || session.connectionFailed) return;
            let locked = best;
            if (
                currentEffectiveKhz !== best.effectiveKhz ||
                currentReportedKhz !== best.effectiveKhz ||
                !session.tcl.connected
            ) {
                const recoveryDeadline = this.clock.monotonicMs() + this._budgetMs();
                const restored =
                    stopReason !== "restore_failed" &&
                    (await this._restoreSpeed(session, best.effectiveKhz, baselineInfo, recoveryDeadline));
                if (session.stopped || session.connectionFailed) return;
                if (!restored) {
                    if (
                        best.effectiveKhz === baseKhz ||
                        !(await this._restoreSpeed(session, baseKhz, baselineInfo, recoveryDeadline))
                    ) {
                        this._abortUnverifiedSpeed(session);
                        return;
                    }
                    locked = verifiedSteps[0];
                    stopReason = "restore_failed";
                }
            }
            const chain = [];
            for (const step of verifiedSteps) {
                if (step.effectiveKhz <= locked.effectiveKhz && !chain.includes(step.effectiveKhz)) {
                    chain.push(step.effectiveKhz);
                }
            }
            chain.sort((a, b) => a - b);
            this.verifiedChain = chain.length ? chain : [baseKhz];
            this._chainIndex = this.verifiedChain.length - 1;
            this.effectiveKhz = locked.effectiveKhz;
            this.requestedKhz = locked.requestedKhz;
            this.state = locked.effectiveKhz > baseKhz ? "tuned" : "unchanged";
            this.reason = stopReason || (locked.effectiveKhz > baseKhz ? "fastest_verified" : "baseline_optimal");
            return frame && frame.epoch === session.sampleEpoch ? locked.frameDurationMs : null;
        } finally {
            this.probingActive = false;
        }
    }

    canStepDown() {
        return (
            this.effectiveKhz !== null &&
            this.baseKhz !== null &&
            this.effectiveKhz > this.baseKhz &&
            this._chainIndex > 0
        );
    }

    recordCycleOutcome(success) {
        if (success) {
            this._runtimeFailures = 0;
            return false;
        }
        this._runtimeFailures++;
        return this.canStepDown() && this._runtimeFailures >= 2;
    }

    requestStepDown() {
        if (this.canStepDown()) this._pendingStepDown = true;
    }

    hasPendingStepDown() {
        return this._pendingStepDown && this.canStepDown();
    }

    async stepDown(session) {
        if (!this.canStepDown()) {
            this._pendingStepDown = false;
            return false;
        }
        this._pendingStepDown = false;
        this._runtimeFailures = 0;
        const nextIndex = this._fallbackCount === 0 ? Math.max(0, this._chainIndex - 1) : 0;
        const targetKhz = this.verifiedChain[nextIndex];
        if (!Number.isInteger(targetKhz) || targetKhz <= 0 || !this._baselineInfo) return false;
        let lockedIndex = nextIndex;
        const deadline = this.clock.monotonicMs() + this._budgetMs();
        if (!(await this._restoreSpeed(session, targetKhz, this._baselineInfo, deadline))) {
            await this._recoverConnection(session);
            if (session.stopped || session.connectionFailed) return false;
            const recoveryDeadline = this.clock.monotonicMs() + this._budgetMs();
            if (await this._restoreSpeed(session, this.effectiveKhz, this._baselineInfo, recoveryDeadline))
                return false;
            if (!(await this._restoreSpeed(session, this.baseKhz, this._baselineInfo, recoveryDeadline))) {
                this._abortUnverifiedSpeed(session);
                return false;
            }
            lockedIndex = 0;
        }
        this._fallbackCount++;
        this._chainIndex = lockedIndex;
        this.effectiveKhz = this.verifiedChain[lockedIndex];
        this.requestedKhz = this.effectiveKhz;
        this.state = "fallback";
        this.reason = "runtime_fallback";
        return true;
    }

    stats() {
        return {
            adapterSpeedKhz: this.effectiveKhz,
            baseAdapterSpeedKhz: this.baseKhz,
            adaptiveSpeed: {
                state: this.state,
                reason: this.reason,
                baseKhz: this.baseKhz,
                effectiveKhz: this.effectiveKhz,
                requestedKhz: this.requestedKhz,
                testedSteps: this.testedSteps.map((step) => ({ ...step }))
            }
        };
    }
}

module.exports = {
    SAMPLING_SPEED_LADDERS_KHZ,
    DEFAULT_SPEED_LADDER_KHZ,
    ALLOWED_TARGETS,
    ALLOWED_TRANSPORTS,
    CPUID_ADDRESS,
    BENCH_RAM_WORDS,
    BENCH_MIN_RAM_WORDS,
    BENCH_CPUID_SCATTER_SEGMENTS,
    BENCH_CPUID_BATCH_COUNT,
    BENCH_CPUID_SINGLE_COUNT,
    DEFAULT_BUDGET_MS,
    TCP_BUDGET_MS,
    STEP_PROBE_TIMEOUT_MS,
    TCP_STEP_PROBE_TIMEOUT_MS,
    IMPROVEMENT_RATIO,
    IMPROVEMENT_MIN_SAVED_MS,
    SLOWDOWN_RATIO,
    MAX_PLATEAU_STEPS,
    MIN_MANUAL_SAMPLING_SPEED_KHZ,
    MAX_MANUAL_SAMPLING_SPEED_KHZ,
    MANUAL_SAMPLING_SPEED_STEP_KHZ,
    DEFAULT_MANUAL_SAMPLING_SPEED_KHZ,
    configuredSamplingSpeedKhz,
    samplingSpeedLadder,
    clampManualSamplingSpeedKhz,
    isValidManualSamplingSpeedKhz,
    parseAdapterSpeedKhz,
    u32ToLittleEndianHex,
    selectBenchmarkRamBlock,
    median,
    isMeaningfulImprovement,
    isSignificantSlowdown,
    midpointCandidateKhz,
    buildBenchmarkPlan,
    verifyBenchmarkReply,
    SamplingSpeedTuner
};
