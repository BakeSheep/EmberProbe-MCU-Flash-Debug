"use strict";

const { MAX_DEBUG_CYCLE_MS } = require("./liveWatchReadPlan");
const { SIDEBAR_INTERVAL_MS } = require("./services/multiRatePlan");

// Owns one sampling transaction and rearms its timer after releasing the shared Tcl connection.
async function sampleTick(session, fromScheduler) {
    if (session.tcl.held || session.tcl.probing || session._starting) return;
    if (!session.samplingEnabled || session.stopped || session._hostHold || !session.tcl.connected) return;
    if (!session.watch.length) return;
    if (!session._tryAcquireExclusive()) {
        // A read/write transaction owns the Tcl connection. The tick runs at its release: dropping it would
        // freeze the watch list, and waiting a whole interval lets frequent peripheral reads starve sampling.
        if (fromScheduler) session._samplingTickDeferred = true;
        return;
    }
    if (session._speedTuner.needsPreCycle(session)) {
        let stopTick;
        try {
            stopTick = await session._speedTuner.runPreCycle(session);
        } finally {
            if (stopTick !== false) session._releaseExclusive();
        }
        if (stopTick) return;
    }
    const epoch = session.sampleEpoch;
    const startMs = session.clock.monotonicMs();
    const targetEpoch = session.targetEpoch;
    const readBytesBefore = session._memoryReadBytes;
    const startedAt = session.clock.now();
    const deadline = startedAt + MAX_DEBUG_CYCLE_MS;
    const ratePlan = session.ratePlan;
    const tick = { ok: false, tuned: false, readStart: null, readEnd: null, frameDurationMs: null };
    let due;
    try {
        due = ratePlan?.due(startMs, session.effectiveIntervalMs, { allowMerge: !session._warmingUp });
        const items = due ? due.items : session.watch;
        if (!items.length && !due?.sidebarNames.length) return;
        const guard = session.mode === "debug" ? { epoch, requireSampling: true, deadline } : null;
        const cycleStart = session.clock.sampleNow();
        if (items.length) tick.readStart = session.clock.monotonicMs();
        const { samples, ok } = items.length
            ? await session._readItems(items, cycleStart, guard)
            : { samples: [], ok: 0 };
        tick.readEnd = session.clock.monotonicMs();
        if (epoch !== session.sampleEpoch || !session.samplingEnabled) return;
        // One sub-millisecond stamp per cycle, centred on its reads, keeps every cycle a single archive/CSV row.
        const t = (cycleStart + session.clock.sampleNow()) / 2;
        for (const sample of samples) sample.t = t;
        const acquiredAt = ((tick.readStart ?? startMs) + tick.readEnd) / 2;
        const delivered = due ? ratePlan.deliver(samples, t, due, acquiredAt) : samples;
        if (session.handlers.onSample) session.handlers.onSample(delivered, t, due);
        if (!items.length) return;
        if (ok === items.length) {
            tick.ok = true;
            if (session._scatterRecheck) {
                session._scatterRecheck = false;
                try {
                    session.scatterReads = (await session.tcl.sendChecked("emberprobe_read_scatter version")) === "1";
                } catch {
                    // Still unsupported (for example an HLA target): keep the batch path.
                }
            }
            if (session._speedTuner.shouldRecheckAfterFirstCycle()) {
                tick.frameDurationMs = await session._speedTuner.tune(session);
                tick.tuned = true;
            }
            if (session._sampleErrorActive) {
                // One successful memory read does not prove target polling recovered.
                session._successfulReads++;
                if (session._successfulReads >= 3 && session.clock.now() - session._lastErrorAt >= 2000) {
                    session._sampleErrorActive = false;
                    session._lastReportedError = "";
                    session._pollFailureSince = null;
                    session._pollFailureCount = 0;
                    session._lastReadError = "";
                    session._notifiedError = "";
                    session._status({ key: "sb.sampling" });
                }
            }
        } else if (ok === 0 && session._lastReadError && session._lastReadError !== session._notifiedError) {
            session._notifiedError = session._lastReadError;
            session._error(
                "读取内存失败：" + session._lastReadError + "（运行中读取失败时可尝试降低采样率或确认目标状态）"
            );
        }
    } catch (e) {
        if (epoch === session.sampleEpoch && session.samplingEnabled && !session.connectionFailed)
            session._error(e.message);
    } finally {
        if (tick.readStart !== null && epoch === session.sampleEpoch && targetEpoch === session.targetEpoch) {
            const end = tick.readEnd ?? session.clock.monotonicMs();
            const duration = end - tick.readStart;
            if (!tick.tuned && session.samplingEnabled)
                session._samplingThroughput.record(session._memoryReadBytes - readBytesBefore, tick.readStart, end);
            session._missedDeadlines += due?.missedGraphSlots ?? 0;
            if (ratePlan?.graphPriority && !due.graphNames.length)
                session._missedDeadlines += ratePlan.recordSidebarRead(duration, end, session.effectiveIntervalMs);
            else if (ratePlan?.graphPriority && due.mergedSidebar) {
                session._missedDeadlines += ratePlan.recordMergedRead(duration, end, session.effectiveIntervalMs);
                const period = Math.max(ratePlan.graphIntervalMs, session.effectiveIntervalMs);
                if (!tick.tuned && tick.ok && period >= SIDEBAR_INTERVAL_MS && duration <= period)
                    session._recordCycle(duration, tick.ok, startedAt);
            } else if (!tick.tuned) session._recordCycle(duration, tick.ok, startedAt);
            if (tick.tuned || session._speedTuner.needsStepDown(session, epoch, tick.ok))
                await session._speedTuner.finishCycle(session, tick.tuned, tick.frameDurationMs);
            if (ratePlan?.graphPriority && due.graphNames.length && !due.mergedSidebar)
                ratePlan.recordGraphRead(session.clock.monotonicMs(), duration);
        }
        session._releaseExclusive();
        if (fromScheduler && epoch === session.sampleEpoch && session.samplingEnabled && !session.stopped) {
            const now = session.clock.monotonicMs();
            const nextDelay = ratePlan ? ratePlan.delay(now) : Math.max(0, startMs + session.effectiveIntervalMs - now);
            session._scheduleNext(nextDelay);
        }
    }
}

module.exports = { sampleTick };
