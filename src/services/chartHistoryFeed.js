"use strict";
const elfSymbols = require("../elfSymbols");
const { serializeError, toUiError } = require("./errorEnvelope");
const { buildChartHistoryItems } = require("./liveWatchService");
const { estimateHistoryBytes, MAX_BACKLOG_BYTES } = require("./chartHistoryService");
// Backoff before each chart-history worker restart attempt (at most three per run/clear).
const CHART_HISTORY_RECOVERY_DELAYS_MS = Object.freeze([250, 1000, 3000]);

// Feeds each chart panel's samples to the chart history cache and restores panels from the sampling archive: batched
// appends within the shared backlog budget, per-panel history items, archive restores, worker restarts after a failure,
// and the one-time "history limited" notice. host is the MainViewProvider.
class ChartHistoryFeed {
    constructor(host) {
        this.host = host;
        /** @type {Set<Promise<void>>} */
        this.pendingAppends = new Set();
        // Bytes batched on the host and not yet sent to the worker.
        this.queuedBytes = 0;
        /** @type {Promise<void> | null} */
        this.recovery = null;
        /** @type {readonly number[]} */
        this.recoveryDelaysMs = CHART_HISTORY_RECOVERY_DELAYS_MS;
        this.recoveryAttempts = 0;
        this.limitedWarned = false;
        this.recoveryErrorWarned = false;
    }
    resetWarnings() {
        this.limitedWarned = false;
        this.recoveryErrorWarned = false;
        this.recoveryAttempts = 0;
    }
    handleError(error) {
        if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code)) {
            this.warnLimited();
            return;
        }
        // Sampling and the archive of record continue while the cache is unavailable.
        for (const entry of this.host._livePanels.values()) {
            entry._historyRecoveryReady = false;
            this.discardAppend(entry);
        }
        void this.recover();
    }
    warnLimited() {
        if (this.limitedWarned) return;
        this.limitedWarned = true;
        // Shown once as a Live Watch notice where the chart is, not as a popup.
        this.host._postLive({ type: "chartHistoryLimited" });
    }
    limit(entry, scope, tick) {
        this.discardAppend(entry);
        const revision = entry.historyRevision || 0;
        const marker = entry._historyLimit;
        if (marker?.scope === scope && marker.revision === revision) return marker.task;
        const task = this.host._chartHistory.limit
            ? this.host._chartHistory.limit(scope, tick)
            : this.host._chartHistory.request("markLimited", [scope, tick]);
        const pending = (this.pendingAppends ||= new Set());
        const tracked = task
            .then((status) => {
                if (status?.limited) this.warnLimited();
            })
            .catch((error) => this.host._chartHistory.fail(error))
            .finally(() => {
                pending.delete(tracked);
                if (entry._historyLimit?.task === tracked) entry._historyLimit = null;
            });
        entry._historyLimit = { scope, revision, task: tracked };
        pending.add(tracked);
        return tracked;
    }
    discardAppend(entry) {
        if (entry._historyBatchTimer) clearTimeout(entry._historyBatchTimer);
        entry._historyBatchTimer = null;
        this.queuedBytes = Math.max(0, (this.queuedBytes || 0) - (entry._historyBatch?.bytes || 0));
        entry._historyBatch = null;
    }
    queueAppend(entry, samples, tick) {
        if (!this.host._chartHistory || !samples.length) return;
        if (entry._historyRestoreTask || (this.recovery && !entry._historyRecoveryReady)) {
            entry._historyRestoreGapTick = tick;
            return;
        }
        if (this.host._chartHistory.failed) return;
        const scope = this.host._debugSamplingScope(entry.watchKey);
        const revision = entry.historyRevision || 0;
        if (entry._historyBatch && (entry._historyBatch.scope !== scope || entry._historyBatch.revision !== revision))
            this.discardAppend(entry);
        const bytes = estimateHistoryBytes([scope, samples, tick]);
        const queuedBytes = (this.queuedBytes || 0) + bytes;
        // Host batching and worker IPC share the existing backlog budget.
        if (queuedBytes + (this.host._chartHistory.queuedBytes || 0) > MAX_BACKLOG_BYTES) {
            this.limit(entry, scope, tick);
            return;
        }
        const batch = (entry._historyBatch ||= { scope, revision, samples: [], tick, bytes: 0 });
        batch.tick = Math.max(batch.tick, tick);
        batch.bytes += bytes;
        this.queuedBytes = queuedBytes;
        for (const sample of samples) batch.samples.push(sample.t == null ? { ...sample, t: tick } : sample);
        if (batch.bytes >= 256 * 1024) this.flushAppend(entry);
        else if (!entry._historyBatchTimer) entry._historyBatchTimer = setTimeout(() => this.flushAppend(entry), 50);
    }
    flushAppend(entry) {
        const batch = entry._historyBatch;
        this.discardAppend(entry);
        if (
            !batch ||
            !this.host._chartHistory ||
            this.host._chartHistory.failed ||
            entry._historyRestoreTask ||
            (this.recovery && !entry._historyRecoveryReady) ||
            batch.scope !== this.host._debugSamplingScope(entry.watchKey) ||
            batch.revision !== (entry.historyRevision || 0)
        )
            return;
        batch.samples.sort((a, b) => a.t - b.t);
        const pending = (this.pendingAppends ||= new Set());
        const task = this.host._chartHistory
            .request("append", [batch.scope, batch.samples, batch.tick])
            .then((status) => {
                if (status?.limited) this.warnLimited();
            })
            .catch((error) => {
                if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code))
                    return this.limit(entry, batch.scope, batch.tick);
                this.host._chartHistory.fail(error);
            })
            .finally(() => pending.delete(task));
        pending.add(task);
        return task;
    }
    flushPending() {
        for (const entry of this.host._livePanels?.values() || []) this.flushAppend(entry);
        return Promise.all([...(this.pendingAppends || [])]);
    }
    configure(entry, acquisitionTime = Date.now()) {
        if (!this.host._chartHistory) return;
        const scope = this.host._debugSamplingScope(entry.watchKey);
        const watched = this.host._scalarWatchList(entry.watchKey);
        const owners = new Set(watched.map((item) => item.name));
        for (const [name, leaf] of entry.runtimeHistoryLeaves || [])
            if (!owners.has(leaf.runtimeOwner)) entry.runtimeHistoryLeaves.delete(name);
        const items = buildChartHistoryItems(watched, elfSymbols, [...(entry.runtimeHistoryLeaves?.values() || [])]);
        const identity = (item) => JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]);
        const previous = new Map(
            (entry.historyScope === scope ? entry.historyItems || [] : []).map((item) => [item.name, item])
        );
        if (entry.historyScope && entry.historyScope !== scope) {
            this.discardAppend(entry);
            this.host._chartHistory
                .request("remove", [entry.historyScope])
                .catch((error) => this.host._chartHistory.fail(error));
        }
        entry.historyScope = scope;
        const signature = JSON.stringify([scope, items]);
        if (entry.historySignature === signature) return;
        this.flushAppend(entry);
        entry.historySignature = signature;
        entry.historyItems = items.map((item) => ({
            ...item,
            historyIdentity: identity(item),
            historyFromMs:
                previous.has(item.name) && previous.get(item.name).historyIdentity === identity(item)
                    ? previous.get(item.name).historyFromMs
                    : acquisitionTime
        }));
        entry.historyIdentities = new Map(entry.historyItems.map((item) => [item.name, item.historyIdentity]));
        this.host._chartHistory
            .request("configure", [scope, entry.historyItems, this.host._samplingArchive.generations?.get(scope) || 0])
            .then((status) => {
                if (entry.historySignature === signature && entry.ready)
                    entry.post({ type: "chartHistoryStatus", ...status, historyRevision: entry.historyRevision || 0 });
            })
            .catch((error) => this.host._chartHistory.fail(error));
    }
    restore(entry, names, recoveryToken) {
        if (entry._historyRestoreTask) return entry._historyRestoreTask;
        this.flushAppend(entry);
        const scope = this.host._debugSamplingScope(entry.watchKey);
        const revision = entry.historyRevision || 0;
        const signature = entry.historySignature;
        const current = () =>
            (!recoveryToken || recoveryToken.active) &&
            !this.host._chartHistory.disposed &&
            !this.host._shutdownPromise &&
            [...this.host._livePanels.values()].includes(entry) &&
            scope === this.host._debugSamplingScope(entry.watchKey) &&
            revision === (entry.historyRevision || 0) &&
            signature === entry.historySignature;
        let restoredThrough = -Infinity;
        const task = (async () => {
            await this.flushPending();
            if (!current()) return;
            const source = await this.host._samplingArchive.historySource(scope);
            if (!current()) return;
            await this.host._chartHistory.request("restore", [{ ...source, names }]);
            if (!current()) return;
            // One bounded catch-up pass includes samples archived during the first scan.
            const catchup = await this.host._samplingArchive.historySource(scope);
            if (!current()) return;
            if (catchup.generation !== source.generation) return;
            if (catchup.cutoff > source.cutoff)
                await this.host._chartHistory.request("restore", [{ ...catchup, names, fromOffset: source.cutoff }]);
            if (!current()) return;
            restoredThrough = catchup.lastTimestampMs;
            const status = await this.host._chartHistory.request("status", [scope]);
            if (current()) {
                if (status.limited) this.warnLimited();
                entry.post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
            }
        })()
            .catch((error) => {
                if (error.code !== "CHART_HISTORY_RESTORE_CANCELLED") throw error;
            })
            .finally(async () => {
                if (entry._historyRestoreTask !== task) return;
                entry._historyRestoreTask = null;
                if (!current()) return;
                entry._historyRecoveryReady = true;
                const gapTick = entry._historyRestoreGapTick;
                entry._historyRestoreGapTick = null;
                // Partial restores also leave other channels' skipped samples missing.
                if (Number.isFinite(gapTick) && (names || gapTick > restoredThrough)) {
                    const status = await this.host._chartHistory.request("markLimited", [scope, gapTick]);
                    if (current()) {
                        if (status.limited) this.warnLimited();
                        entry.post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
                    }
                }
            });
        entry._historyRestoreTask = task;
        entry._historyRestoreToken = recoveryToken;
        return task;
    }
    recover() {
        if (this.recovery) return this.recovery;
        if (!this.host._chartHistory?.failed || this.host._chartHistory.disposed || this.host._shutdownPromise)
            return Promise.resolve();
        const task = (async () => {
            let error = this.host._chartHistory.failed;
            // At most three restarts per run/clear, including recurring failures after a successful recovery.
            while ((this.recoveryAttempts || 0) < 3) {
                const attempt = (this.recoveryAttempts = (this.recoveryAttempts || 0) + 1);
                const delays = this.recoveryDelaysMs || CHART_HISTORY_RECOVERY_DELAYS_MS;
                await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
                if (this.host._chartHistory.disposed || this.host._shutdownPromise) return;
                let timer;
                const token = { active: true };
                try {
                    await Promise.race([
                        (async () => {
                            for (const entry of this.host._livePanels.values()) entry._historyRecoveryReady = false;
                            await this.flushPending();
                            await this.host._chartHistory.restart();
                            if (!token.active) return;
                            for (const entry of this.host._livePanels.values()) {
                                if (!token.active) return;
                                entry.historyRevision = (entry.historyRevision || 0) + 1;
                                entry.post({ type: "debugSessionChanged" });
                                const scope = this.host._debugSamplingScope(entry.watchKey);
                                await this.host._chartHistory.request("configure", [
                                    scope,
                                    entry.historyItems || this.host._scalarWatchList(entry.watchKey),
                                    this.host._samplingArchive.generations?.get(scope) || 0
                                ]);
                                if (!token.active) return;
                                if (entry.historyViewportNames?.length)
                                    await this.host._chartHistory.request("touchViewport", [
                                        scope,
                                        entry.historyViewportNames
                                    ]);
                                if (!token.active) return;
                                await this.restore(entry, undefined, token);
                            }
                            if (this.host._chartHistory.failed) throw this.host._chartHistory.failed;
                        })(),
                        new Promise((resolve, reject) => {
                            timer = setTimeout(() => {
                                token.active = false;
                                reject(new Error("History recovery timed out"));
                            }, 30000);
                        })
                    ]);
                    return;
                } catch (failure) {
                    error = failure;
                    token.active = false;
                    for (const entry of this.host._livePanels.values())
                        if (entry._historyRestoreToken === token) entry._historyRestoreTask = null;
                    this.host._chartHistory.fail(failure);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (!this.recoveryErrorWarned) {
                this.recoveryErrorWarned = true;
                this.host._postLive({
                    type: "liveError",
                    ...toUiError(
                        Object.assign(new Error(this.host._t("lw.historyRecoveryFailed")), {
                            i18nKey: "lw.historyRecoveryFailed",
                            details: { cause: serializeError(error) }
                        })
                    )
                });
            }
        })().finally(() => {
            if (this.recovery === task) this.recovery = null;
        });
        this.recovery = task;
        return task;
    }
}

module.exports = { ChartHistoryFeed };
