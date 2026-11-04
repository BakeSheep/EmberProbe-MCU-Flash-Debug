"use strict";

const DEFAULT_FREQUENCY_HZ = 30;
const MIN_FREQUENCY_HZ = 0.1;
const MAX_FREQUENCY_HZ = 200;

function normalizeFrequencyHz(value, fallback = DEFAULT_FREQUENCY_HZ) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(MAX_FREQUENCY_HZ, Math.max(MIN_FREQUENCY_HZ, Math.round(number * 10) / 10));
}

function intervalMsFromHz(value) {
    return Math.min(10000, Math.max(5, Math.round(1000 / normalizeFrequencyHz(value))));
}

function frequencyHzFromInterval(intervalMs) {
    const interval = Number(intervalMs);
    return Number.isFinite(interval) && interval > 0 ? normalizeFrequencyHz(1000 / interval) : DEFAULT_FREQUENCY_HZ;
}

function configuredFrequencyHz(configuration) {
    return normalizeFrequencyHz(configuration.get("sampleFrequencyHz", DEFAULT_FREQUENCY_HZ));
}

module.exports = {
    DEFAULT_FREQUENCY_HZ,
    MIN_FREQUENCY_HZ,
    MAX_FREQUENCY_HZ,
    normalizeFrequencyHz,
    intervalMsFromHz,
    frequencyHzFromInterval,
    configuredFrequencyHz
};
