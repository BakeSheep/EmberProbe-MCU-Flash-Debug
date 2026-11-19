"use strict";

const { normalizeAdapterSpeed, probeFamily } = require("../skills/_emberprobe/probe-connection");
const { SYSTEM_CLOCK } = require("./samplingClock");
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
const IMPROVEMENT_MIN_RATIO = 0.03;
const IMPROVEMENT_MIN_SAVED_MS = 0.15;
const SLOWDOWN_RATIO = 1.1;
const MAX_PLATEAU_STEPS = 2;

const ELIGIBILITY_QUERY_CMD =
    "set _ep_t [target current]; " +
    'set _ep_rd [expr {[llength [info commands read_memory]] ? "read_memory" : "ocd_read_memory"}]; ' +
    'join [list [$_ep_t cget -type] [transport select] [adapter speed] [$_ep_rd 0xE000ED00 32 1] $_ep_rd] "\\n"';

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
    return gain >= IMPROVEMENT_RATIO || (gain >= IMPROVEMENT_MIN_RATIO && savedMs >= IMPROVEMENT_MIN_SAVED_MS);
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

function resetSessionMetrics(session) {
    session._recentDurations = [];
    session._consecutiveSuccesses = 0;
    session._recentCycleTimestamps = [];
    session._pollFailureSince = null;
    session._pollFailureCount = 0;
    session._samplingThroughput.reset();
}

async function ensureConnected(session) {
    if (session.stopped || session.connectionFailed) return false;
    try {
        await session._ensureTclConnected?.();
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
        } else if (this.options.adaptiveAdapterSpeed === false) {
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
        this._runtimeFailures = 0;
        this._fallbackCount = 0;
        this._pendingStepDown = false;
    }

    isEnabled() {
        return (
            this.mode === "standalone" && this.configuredSpeedKhz === 0 && this.options.adaptiveAdapterSpeed !== false
        );
    }

    shouldTuneAtStart(watch) {
        return (
            this.isEnabled() &&
            !this._tuned &&
            (this.options.adaptiveAdapterSpeed === true || (Array.isArray(watch) && watch.length > 0))
        );
    }

    shouldTuneBeforeTick(startCompleted, watch) {
        return this.isEnabled() && startCompleted === true && !this._tuned && Array.isArray(watch) && watch.length > 0;
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
        return this.hasPendingStepDown() || this.shouldTuneBeforeTick(session._startCompleted, session.watch);
    }

    async runPreCycle(session) {
        let changed = false;
        if (this.hasPendingStepDown()) changed = await this.stepDown(session);
        else if (this.shouldTuneBeforeTick(session._startCompleted, session.watch)) {
            await this.tune(session);
            changed = true;
        }
        if (changed) resetSessionMetrics(session);
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

    async finishCycle(session, tunedInCycle) {
        try {
            if (tunedInCycle || (await this.stepDown(session))) resetSessionMetrics(session);
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

    async _probeEligibility(session, stepTimeoutMs) {
        let response;
        this._tentativeError = null;
        this.probingActive = true;
        try {
            response = await session.tcl.probe(ELIGIBILITY_QUERY_CMD, stepTimeoutMs);
        } catch (error) {
            if (!session.stopped && !session.connectionFailed) {
                if (/not examined/i.test(String(error?.message || ""))) {
                    this._recheckAfterFirstCycle = true;
                    this._tuned = false;
                } else {
                    this.state = "ineligible";
                    this.reason = "baseline_read_failed";
                }
                await ensureConnected(session);
            }
            return null;
        } finally {
            this.probingActive = false;
        }
        if (session.stopped || session.connectionFailed) return null;
        const lines = String(response || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length !== 5) {
            this.state = "ineligible";
            this.reason = "invalid_baseline";
            return null;
        }
        const [targetType, transport, speedLine, cpuidLine, readCmd] = lines;
        if (!ALLOWED_TARGETS.has(targetType) || !ALLOWED_TRANSPORTS.has(transport)) {
            this.state = "ineligible";
            this.reason = "unsupported_target_or_transport";
            return null;
        }
        const baseKhz = parseAdapterSpeedKhz(speedLine);
        const cpuidValues = parseMemoryElements(cpuidLine, 32);
        const expectedCpuid = cpuidValues.length === 1 ? cpuidValues[0] : 0;
        if (
            baseKhz <= 0 ||
            expectedCpuid === 0 ||
            expectedCpuid === 0xffffffff ||
            !["read_memory", "ocd_read_memory"].includes(readCmd)
        ) {
            this.state = "ineligible";
            this.reason = "invalid_baseline";
            return null;
        }
        return { baseKhz, expectedCpuid, readCmd };
    }

    async _sendBenchmark(session, plan, timeoutMs) {
        const replies = [];
        for (const cmd of plan.commands) {
            this._tentativeError = null;
            try {
                const reply = await session.tcl.probe(cmd, timeoutMs);
                if (this._tentativeError || session.stopped || session.connectionFailed) {
                    return { ok: false, batchUnsupported: false };
                }
                replies.push(reply);
            } catch (error) {
                return { ok: false, batchUnsupported: isBatchSyntaxError(error) };
            }
        }
        return { ok: verifyBenchmarkReply(plan, replies), batchUnsupported: false };
    }

    async _measureStep(session, plan, stepTimeoutMs, timedCount = null) {
        const warmStart = this.clock.monotonicMs();
        const warmup = await this._sendBenchmark(session, plan, stepTimeoutMs);
        const warmMs = this.clock.monotonicMs() - warmStart;
        if (!warmup.ok) return { ok: false, medianMs: null, batchUnsupported: warmup.batchUnsupported };
        const count = timedCount ?? (warmMs > 60 ? 2 : 3);
        const durations = [];
        for (let i = 0; i < count; i++) {
            const t0 = this.clock.monotonicMs();
            const res = await this._sendBenchmark(session, plan, stepTimeoutMs);
            const dt = this.clock.monotonicMs() - t0;
            if (!res.ok) return { ok: false, medianMs: null, batchUnsupported: res.batchUnsupported };
            durations.push(dt);
        }
        const med = median(durations);
        return med === null
            ? { ok: false, medianMs: null, batchUnsupported: false }
            : { ok: true, medianMs: med, timedCount: count, batchUnsupported: false };
    }

    async _measureBaseline(session, expectedCpuid, readCmd, stepTimeoutMs) {
        const initialRamBlock = selectBenchmarkRamBlock(session.watch, session.ramSectionRanges);
        const attempts = initialRamBlock ? [initialRamBlock, null] : [null];
        for (const ramBlock of attempts) {
            if (session.stopped || session.connectionFailed) return null;
            let plan = buildBenchmarkPlan({
                scatterReads: !!session.scatterReads,
                readCmd,
                ramBlock,
                expectedCpuid,
                batchUnsupported: !!session._batchUnsupported
            });
            this.probingActive = true;
            let res;
            try {
                res = await this._measureStep(session, plan, stepTimeoutMs);
                if (!res.ok && res.batchUnsupported) {
                    session._batchUnsupported = true;
                    plan = buildBenchmarkPlan({
                        scatterReads: !!session.scatterReads,
                        readCmd,
                        ramBlock,
                        expectedCpuid,
                        batchUnsupported: true
                    });
                    res = await this._measureStep(session, plan, stepTimeoutMs);
                }
            } finally {
                this.probingActive = false;
            }
            if (res.ok) return { plan, medianMs: res.medianMs, timedCount: res.timedCount };
            await ensureConnected(session);
        }
        return null;
    }

    async _restoreSpeed(session, targetKhz, expectedCpuid, readCmd, stepTimeoutMs) {
        if (!(await ensureConnected(session))) return false;
        this._lastReduced = null;
        this._tentativeError = null;
        this.probingActive = true;
        try {
            await session.tcl.probe(`adapter speed ${targetKhz}`, stepTimeoutMs);
            const reply = await session.tcl.probe(`${readCmd} 0x${CPUID_ADDRESS.toString(16)} 32 1`, stepTimeoutMs);
            return !this._tentativeError && verifyWordElement(reply, expectedCpuid);
        } catch {
            await ensureConnected(session);
            return false;
        } finally {
            this.probingActive = false;
        }
    }

    async _probeCandidate(session, khz, plan, stepTimeoutMs, timedCount, testedEffective) {
        this._lastReduced = null;
        this._tentativeError = null;
        this.probingActive = true;
        try {
            let speedReply;
            try {
                speedReply = await session.tcl.probe(`adapter speed ${khz}`, stepTimeoutMs);
            } catch {
                return { status: "rejected" };
            }
            const reportedKhz = parseAdapterSpeedKhz(speedReply) || khz;
            let effectiveKhz = this._resolveEffectiveKhz(khz, reportedKhz);
            if (testedEffective.has(effectiveKhz)) {
                return { status: "duplicate", reportedKhz, effectiveKhz };
            }
            const step = await this._measureStep(session, plan, stepTimeoutMs, timedCount);
            effectiveKhz = this._resolveEffectiveKhz(khz, reportedKhz);
            return {
                status: step.ok ? "ok" : "failed",
                reportedKhz,
                effectiveKhz,
                medianMs: step.medianMs
            };
        } finally {
            this.probingActive = false;
        }
    }

    async tune(session) {
        if (!this.isEnabled() || session.stopped || session.connectionFailed || !session.tcl.connected) return;
        this._tuned = true;
        this._recheckAfterFirstCycle = false;
        const startedAt = this.clock.monotonicMs();
        const stepTimeoutMs = this._stepTimeoutMs();
        const budgetMs = this._budgetMs();

        const baselineInfo = await this._probeEligibility(session, stepTimeoutMs);
        if (!baselineInfo) return;
        const { baseKhz, expectedCpuid, readCmd } = baselineInfo;
        this.baseKhz = baseKhz;
        this.effectiveKhz = baseKhz;
        this.requestedKhz = baseKhz;

        const primary = samplingSpeedLadder(this.options).filter((k) => k > baseKhz);
        if (!primary.length) {
            this.state = "unchanged";
            this.reason = "at_ceiling";
            this.verifiedChain = [baseKhz];
            this._chainIndex = 0;
            return;
        }

        const baseline = await this._measureBaseline(session, expectedCpuid, readCmd, stepTimeoutMs);
        if (!baseline) {
            this.state = "ineligible";
            this.reason = "baseline_read_failed";
            return;
        }

        let best = { requestedKhz: baseKhz, effectiveKhz: baseKhz, medianMs: baseline.medianMs };
        const verifiedSteps = [best];
        const testedEffective = new Set([baseKhz]);
        const attemptedRequested = new Set([baseKhz]);
        let queue = primary.map((khz) => ({ khz, refined: false }));
        let lastGoodRequestedKhz = baseKhz;
        let currentEffectiveKhz = baseKhz;
        let currentReportedKhz = baseKhz;
        let plateauCount = 0;
        let stopReason = "";
        this.testedSteps = [];

        while (queue.length) {
            if (session.stopped || session.connectionFailed) return;
            if (this.clock.monotonicMs() - startedAt >= budgetMs) {
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

            const probe = await this._probeCandidate(
                session,
                khz,
                baseline.plan,
                stepTimeoutMs,
                baseline.timedCount,
                testedEffective
            );
            if (session.stopped || session.connectionFailed) return;
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
            currentEffectiveKhz = rejected ? currentEffectiveKhz : probe.effectiveKhz;
            this.testedSteps.push({
                requestedKhz: khz,
                effectiveKhz: stepEffective,
                medianMs: rejected ? null : probe.medianMs,
                ok: probe.status === "ok"
            });
            if (rejected || probe.status === "failed") {
                const restored = await this._restoreSpeed(
                    session,
                    best.effectiveKhz,
                    expectedCpuid,
                    readCmd,
                    stepTimeoutMs
                );
                if (!restored) {
                    if (best.effectiveKhz !== baseKhz)
                        await this._restoreSpeed(session, baseKhz, expectedCpuid, readCmd, stepTimeoutMs);
                    best = { requestedKhz: baseKhz, effectiveKhz: baseKhz, medianMs: baseline.medianMs };
                    currentEffectiveKhz = baseKhz;
                    currentReportedKhz = baseKhz;
                    stopReason = "restore_failed";
                    break;
                }
                currentEffectiveKhz = best.effectiveKhz;
                currentReportedKhz = best.effectiveKhz;
                if (!entry.refined) {
                    const mid = midpointCandidateKhz(lastGoodRequestedKhz, khz);
                    if (mid && !attemptedRequested.has(mid)) {
                        queue = [{ khz: mid, refined: true }];
                        continue;
                    }
                }
                stopReason = rejected ? "driver_rejected" : "stability_limit";
                break;
            }

            lastGoodRequestedKhz = khz;
            if (testedEffective.has(probe.effectiveKhz)) {
                stopReason = "driver_clamped";
                break;
            }
            testedEffective.add(probe.effectiveKhz);
            verifiedSteps.push({ requestedKhz: khz, effectiveKhz: probe.effectiveKhz, medianMs: probe.medianMs });
            if (isMeaningfulImprovement(best.medianMs, probe.medianMs)) {
                best = { requestedKhz: khz, effectiveKhz: probe.effectiveKhz, medianMs: probe.medianMs };
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
        if (currentEffectiveKhz !== best.effectiveKhz || currentReportedKhz !== best.effectiveKhz) {
            const restored = await this._restoreSpeed(
                session,
                best.effectiveKhz,
                expectedCpuid,
                readCmd,
                stepTimeoutMs
            );
            if (!restored && best.effectiveKhz !== baseKhz) {
                await this._restoreSpeed(session, baseKhz, expectedCpuid, readCmd, stepTimeoutMs);
                locked = { requestedKhz: baseKhz, effectiveKhz: baseKhz, medianMs: baseline.medianMs };
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
        if (!Number.isInteger(targetKhz) || targetKhz <= 0 || !(await ensureConnected(session))) return false;
        this.probingActive = true;
        try {
            await session.tcl.probe(`adapter speed ${targetKhz}`, this._stepTimeoutMs());
        } catch {
            await ensureConnected(session);
            return false;
        } finally {
            this.probingActive = false;
        }
        this._fallbackCount++;
        this._chainIndex = nextIndex;
        this.effectiveKhz = targetKhz;
        this.requestedKhz = targetKhz;
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
    IMPROVEMENT_MIN_RATIO,
    IMPROVEMENT_MIN_SAVED_MS,
    SLOWDOWN_RATIO,
    MAX_PLATEAU_STEPS,
    configuredSamplingSpeedKhz,
    samplingSpeedLadder,
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
