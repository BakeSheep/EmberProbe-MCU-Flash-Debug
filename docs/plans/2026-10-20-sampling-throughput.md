# Sampling Throughput Implementation Plan

**Goal:** Display `xxxkb/s | xxx.xHz` in the existing waveform sidebar rate label, including unlimited sampling.

**Architecture:** Count validated memory bytes in existing single and batch reads. Measure sampling-cycle deltas with a monotonic clock and a one-second average using constant memory. Forward the result through existing worker statistics and chart messages; add no hardware reads, polling timers, controls, or layout changes.

**Tech Stack:** CommonJS JavaScript, Node.js monotonic clock, existing Webview renderer and assert-based tests.

## Tasks

1. Add a throughput accumulator and tests for elapsed time, failed reads, idle expiry, and reset. Count merged reads once and include runtime-object reads; exclude one-shot transactions outside sampling.
2. Add `bytesPerSecond` to session statistics and waveform telemetry. Reset on sampling, rate, and target changes. Preserve ownership and read budgets.
3. Update only the existing rate text to decimal kilobytes per second (1,000 bytes), using the requested literal `kb/s`, and one decimal place for Hz. Remove the unlimited prefix. Keep tooltips and other frontend behavior.
4. Extend sampling and Webview regression tests, register the new test, and run focused tests, `npm run check`, `npm run quality`, `npm run bundle`, and `npm run test:e2e`. Capture a waveform preview if the browser environment supports it.

## Measurement boundary

This measures successfully decoded target-memory bytes during sampling, including merged address spans and dynamic-object reads. It excludes protocol framing, USB/SWD overhead, and standalone reads/writes. Failed responses add no bytes; valid reads before a later cycle failure still count. The rate becomes available after the first one-second window and resets to zero when sampling stops.

## Validation

- Windows / Node.js 24: `npm run check` passed (413 files, zero failures).
- `npm run quality` passed, including coordinator and safety coverage gates. A dedicated `NODE_V8_COVERAGE` directory avoided concurrent runs overwriting raw coverage. The new accumulator has 100% line, function, and branch coverage.
- `npm run bundle` and `npm run test:e2e` passed. Extension Host tests used a workspace temporary directory because the system temporary directory was not writable.
- Browser preview confirmed that the existing sidebar heading accommodates the new label without layout changes. Preview: `test-results/sampling-throughput-preview.png` (generated and ignored).
- No physical-board or probe validation was performed.
