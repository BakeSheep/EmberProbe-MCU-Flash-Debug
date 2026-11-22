"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSamplingSpeedControl = factory();
})(globalThis, function () {
    const MIN_KHZ = 1000;
    const MAX_KHZ = 20000;
    const STEP_KHZ = 1000;
    const DEFAULT_MANUAL_KHZ = 2000;
    const ADAPTIVE_STATES = new Set(["tuned", "unchanged", "fallback"]);

    function clampDisplayKhz(value) {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) return DEFAULT_MANUAL_KHZ;
        return Math.min(MAX_KHZ, Math.max(MIN_KHZ, num));
    }

    function snapManualKhz(value) {
        const clamped = clampDisplayKhz(value);
        return Math.round(clamped / STEP_KHZ) * STEP_KHZ;
    }

    function rateTitle(m, requestedFrequencyHz, previousTitle) {
        let title = previousTitle || "";
        if (m.effectiveIntervalMs === 0) {
            title = [
                "Target: unlimited",
                "P95: " + (m.p95DurationMs || 0) + "ms",
                "Limited by: " + (m.limitedBy || "-"),
                "Host hold: " + (m.hostHoldMs || 0) + "ms" + (m.pauseReason ? " | Paused: " + m.pauseReason : "")
            ].join(" | ");
        } else if (m.effectiveIntervalMs !== undefined) {
            const targetHz = m.frequencyHz || requestedFrequencyHz;
            title = [
                "Target: " + targetHz + " Hz",
                "Effective: " +
                    (1000 / m.effectiveIntervalMs).toFixed(1) +
                    " Hz (" +
                    Number(m.effectiveIntervalMs.toFixed(3)) +
                    " ms)",
                "P95: " + (m.p95DurationMs || 0) + "ms",
                "Missed: " + (m.missedDeadlines || 0) + (m.pauseReason ? " | Paused: " + m.pauseReason : "")
            ].join(" | ");
        }
        if (title) {
            const extras = [];
            if (m.hostLoopDelayMs !== undefined)
                extras.push(
                    "Host stall: " +
                        (m.hostLoopDelayMs || 0) +
                        "ms | Backlog: " +
                        (m.backlogBatches || 0) +
                        " (" +
                        (m.backlogAgeMs || 0) +
                        "ms) | Dropped: " +
                        (m.droppedBatches || 0)
                );
            if (Number.isFinite(m.adapterSpeedKhz) && m.adapterSpeedKhz > 0)
                extras.push("SWD: " + m.adapterSpeedKhz + " kHz");
            if (extras.length) title += " | " + extras.join(" | ");
        }
        return title;
    }

    function create({ document, post, t }) {
        const option = document.getElementById("samplingClockOption");
        const autoSwitch = document.getElementById("samplingClockAuto");
        const slider = document.getElementById("samplingClockSlider");
        const valueLabel = document.getElementById("samplingClockValue");
        const state = {
            adaptive: true,
            samplingAdapterSpeedKhz: 0,
            adapterSpeedKhz: 0,
            adaptiveEffectiveKhz: null,
            manualSpeedKhz: DEFAULT_MANUAL_KHZ,
            effectiveKhz: null,
            locked: false,
            previewKhz: null
        };

        function resolveAdaptiveDisplayKhz() {
            if (state.adapterSpeedKhz > 0) return state.adapterSpeedKhz;
            if (Number.isFinite(state.adaptiveEffectiveKhz) && state.adaptiveEffectiveKhz > 0)
                return state.adaptiveEffectiveKhz;
            return null;
        }

        function resolveManualDisplayKhz() {
            if (state.previewKhz !== null) return state.previewKhz;
            if (state.samplingAdapterSpeedKhz > 0) return state.samplingAdapterSpeedKhz;
            return state.manualSpeedKhz || DEFAULT_MANUAL_KHZ;
        }

        function render() {
            if (!option || !autoSwitch || !slider || !valueLabel) return;
            autoSwitch.checked = state.adaptive;
            autoSwitch.disabled = state.locked;
            slider.disabled = state.locked || state.adaptive;
            option.classList.toggle("is-locked", state.locked);
            option.classList.toggle("is-auto", state.adaptive);

            const displayKhz = state.adaptive ? resolveAdaptiveDisplayKhz() : resolveManualDisplayKhz();
            slider.value = String(snapManualKhz(displayKhz ?? state.manualSpeedKhz));
            const text = displayKhz === null ? t("lw.samplingClockPending") : `${Math.round(displayKhz) / 1000} MHz`;
            valueLabel.textContent = text;
            slider.setAttribute("aria-valuetext", text);
        }

        if (autoSwitch && slider) {
            autoSwitch.onchange = function () {
                if (state.locked) {
                    render();
                    return;
                }
                const nextAdaptive = Boolean(this.checked);
                state.adaptive = nextAdaptive;
                state.previewKhz = null;
                let commitKhz;
                if (!nextAdaptive) {
                    const base = resolveAdaptiveDisplayKhz() ?? state.manualSpeedKhz;
                    commitKhz = snapManualKhz(base);
                    state.samplingAdapterSpeedKhz = commitKhz;
                    state.manualSpeedKhz = commitKhz;
                } else {
                    state.samplingAdapterSpeedKhz = 0;
                }
                render();
                post(
                    nextAdaptive
                        ? { type: "setSamplingSpeed", adaptive: true }
                        : { type: "setSamplingSpeed", adaptive: false, speedKhz: commitKhz }
                );
            };

            slider.oninput = function () {
                if (state.locked || state.adaptive) {
                    render();
                    return;
                }
                state.previewKhz = snapManualKhz(this.value);
                render();
            };

            slider.onchange = function () {
                if (state.locked || state.adaptive) {
                    state.previewKhz = null;
                    render();
                    return;
                }
                const khz = snapManualKhz(this.value);
                state.previewKhz = null;
                state.manualSpeedKhz = khz;
                state.samplingAdapterSpeedKhz = khz;
                render();
                post({ type: "setSamplingSpeed", adaptive: false, speedKhz: khz });
            };
        }

        return {
            receiveConfig(m) {
                if (!m || typeof m !== "object") return;
                if (typeof m.adaptive === "boolean") state.adaptive = m.adaptive;
                if (Number.isFinite(m.samplingAdapterSpeedKhz) && m.samplingAdapterSpeedKhz >= 0)
                    state.samplingAdapterSpeedKhz = m.samplingAdapterSpeedKhz;
                if (Number.isFinite(m.adapterSpeedKhz) && m.adapterSpeedKhz >= 0)
                    state.adapterSpeedKhz = m.adapterSpeedKhz;
                if (m.adaptiveEffectiveKhz === null) state.adaptiveEffectiveKhz = null;
                else if (Number.isFinite(m.adaptiveEffectiveKhz) && m.adaptiveEffectiveKhz > 0)
                    state.adaptiveEffectiveKhz = m.adaptiveEffectiveKhz;
                if (Number.isFinite(m.manualSpeedKhz) && m.manualSpeedKhz > 0)
                    state.manualSpeedKhz = snapManualKhz(m.manualSpeedKhz);
                if (m.effectiveKhz === null) state.effectiveKhz = null;
                else if (Number.isFinite(m.effectiveKhz) && m.effectiveKhz > 0) state.effectiveKhz = m.effectiveKhz;
                if (typeof m.locked === "boolean") state.locked = m.locked;
                if (state.locked || state.adaptive) state.previewKhz = null;
                render();
            },
            receiveStatus(m, flags) {
                if (!m || typeof m !== "object") return;
                const transitional = m.mode === "disconnecting" || m.mode === "exit-unconfirmed";
                if (flags && (typeof flags.running === "boolean" || typeof flags.starting === "boolean")) {
                    state.locked = Boolean(flags.running || flags.starting || transitional);
                } else if (typeof m.running === "boolean" || typeof m.starting === "boolean" || transitional) {
                    state.locked = Boolean(m.running || m.starting || transitional);
                }
                const adaptiveInfo = m.adaptiveSpeed;
                if (state.adaptive && adaptiveInfo) {
                    if (
                        ADAPTIVE_STATES.has(adaptiveInfo.state) &&
                        Number.isFinite(adaptiveInfo.effectiveKhz) &&
                        adaptiveInfo.effectiveKhz > 0
                    ) {
                        state.adaptiveEffectiveKhz = adaptiveInfo.effectiveKhz;
                    } else if (["pending", "ineligible", "failed", "disabled"].includes(adaptiveInfo.state)) {
                        state.adaptiveEffectiveKhz = null;
                    }
                }
                if (Number.isFinite(m.adapterSpeedKhz) && m.adapterSpeedKhz > 0) {
                    state.effectiveKhz = m.adapterSpeedKhz;
                } else if (m.running === false) {
                    state.effectiveKhz = null;
                }
                if (state.locked) state.previewKhz = null;
                render();
            },
            setRunning(running, starting) {
                state.locked = Boolean(running || starting);
                if (state.locked) state.previewKhz = null;
                render();
            },
            render
        };
    }

    return { MIN_KHZ, MAX_KHZ, STEP_KHZ, DEFAULT_MANUAL_KHZ, clampDisplayKhz, snapManualKhz, rateTitle, create };
});
