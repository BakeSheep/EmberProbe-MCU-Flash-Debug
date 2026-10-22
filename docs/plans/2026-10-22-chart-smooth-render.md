# P1: cached chart translation and smooth follow

Builds on [P0 viewport requests](2026-10-21-chart-viewport-requests.md) and its atomic detail commits. No host,
Worker protocol, sampling, archive or hardware changes.

Files changed for P1:

- Rendering: `src/webview/liveWatch/chart.js`, `src/webview/liveWatch/chartInspection.js`,
  `src/webview/liveWatch/renderer.js`.
- Tests: `test/chart-smooth-render.test.js` (new), `test/chart-controls.test.js`, `test/chart-experience.test.js`,
  `test/chart-remote-history.test.js`, `test/chart-render-budget.test.js`, `test/chart-viewport-requests.test.js`;
  registration in `scripts/test-groups.js`.
- Benchmarks: `test/perf/layered-history-bench.js`, `test/perf/chart-history-bench.js` (geometry representation update).
- Documentation: `docs/LAYERED-SAMPLING.md` and this file.

## Rendering

- Integer preparation depends on the supplied series identity and normalization setting. Its origin uses the latest
  exact large integer in the first applicable supplied segment, independent of the viewport. Missing samples retain
  their null value. BigInt subtraction and axis formatting preserve adjacent u64/i64 values.
- Geometry covers the view plus half a span on each side. Each segment retains Float64 x/y offsets relative to a build
  origin, references to raw samples and Uint32 envelope indices. Envelope columns use relative x offsets. No point
  objects, Set or sort are allocated per column during geometry construction.
- Unchanged data, normalization, canvas/DPR, padding and x/y spans reuse geometry while the view stays inside its build
  window. Drawing and inspection apply the current translation. Binary searches limit path emission to visible envelope
  indices plus one neighbour on each side. Null samples and separate segments remain disconnected.
- Ordinary autoY and normalization use visible samples. Smooth follow holds their ranges between accepted detail
  commits. Visibility/normalization/origin changes still invalidate the appropriate ranges.

## Following and requests

- Smooth follow applies to running backend history, fixed-span follow windows, no freeze/drag operation and no reduced
  motion preference. Presets retain their duration even while initial history is shorter; custom windows retain their
  chosen span. “All” retains P0 step following.
- An accepted detail reply records the committed data maximum and local monotonic time. The display clock advances
  using elapsed local time and a 0.9–1.1 correction rate. Its target uses the commit-interval EMA plus one frame of lag,
  projected by local time since the commit. The display never rewinds or exceeds committed data, and stops at that
  maximum during a stall. No comparison of remote timestamps with the local wall clock is made.
- Presets, dragging, freeze/resume, clear, generation/configuration changes and leaving follow reset the clock. Changing
  to reduced motion restores atomic step following. Canvas and timeline dragging both suspend smooth follow.
- Follow drawing uses a minimum interval of clamp(2 × draw-duration EMA, 16, 80) ms. Other views keep P0's 80 ms and
  fast-dirty behavior. Detail requests use the displayed range and retain P0's overscan and response acceptance rules.
- Revision-only follow refresh waits max(80 ms, visible span / canvas columns). Range/configuration/resolution changes
  remain immediate subject to the shared request throttle. Overview refresh keeps P0's rule.

## Software benchmark

`node test/perf/layered-history-bench.js`, Node v24.13.1, Windows, JSDOM Canvas stub, 200 Hz history, 4 warmup frames and
12 measured frames per case. The pan measurement holds follow statistics and data fixed, asserts that cached frames
retain geometry identity, then compares forced geometry rebuilding. Both measurements include the complete `draw()`
path, DOM controls and Canvas method emission; they do not measure browser Canvas stroking or hardware throughput.

Milliseconds, median / P95:

| Channels | History (min) | Visible | View (s) | Cached pan | Rebuild pan |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 20 | 3 | 30 | 2.383 / 3.877 | 3.784 / 4.560 |
| 3 | 20 | 3 | 1200 | 2.494 / 3.395 | 4.171 / 5.113 |
| 3 | 20 | 1 | 30 | 1.842 / 3.155 | 2.080 / 4.508 |
| 3 | 20 | 1 | 1200 | 2.156 / 2.885 | 2.587 / 3.867 |
| 3 | 30 | 3 | 30 | 2.442 / 3.525 | 3.572 / 4.841 |
| 3 | 30 | 3 | 1800 | 2.428 / 2.671 | 4.555 / 5.102 |
| 3 | 30 | 1 | 30 | 2.051 / 4.245 | 3.103 / 6.395 |
| 3 | 30 | 1 | 1800 | 2.296 / 3.310 | 2.725 / 3.612 |
| 10 | 20 | 10 | 30 | 3.461 / 3.985 | 6.931 / 9.277 |
| 10 | 20 | 10 | 1200 | 3.136 / 4.978 | 9.590 / 11.916 |
| 10 | 20 | 1 | 30 | 2.077 / 3.514 | 3.192 / 4.213 |
| 10 | 20 | 1 | 1200 | 1.816 / 3.837 | 2.606 / 3.812 |
| 10 | 30 | 10 | 30 | 3.061 / 5.535 | 6.879 / 8.365 |
| 10 | 30 | 10 | 1800 | 3.092 / 5.199 | 9.509 / 14.398 |
| 10 | 30 | 1 | 30 | 1.742 / 2.826 | 2.192 / 3.707 |
| 10 | 30 | 1 | 1800 | 1.894 / 2.961 | 2.472 / 3.396 |

## Verification

Baseline `npm run check`: 437 files, zero failures. P1 adds `test/chart-smooth-render.test.js` to the integration group;
existing geometry readers in chart tests and benchmarks use raw references or translated `pointAt()` coordinates.
Deterministic RAF/performance tests cover translation reuse/rebuild, hit testing, gaps, last dots, huge integers,
commit/frame monotonicity, stalled data, lifecycle/reduced motion, held autoY/normalization and slow-draw cadence.
Viewport tests cover 80 ms short-span and per-column long-span follow revision refresh.

Completed checks: seven focused chart suites passed; `npm run check` passed with 438 files and zero failures;
`npm run quality` passed ESLint, Prettier checks, JavaScript type checking and 216 quality test files with zero failures.
Coverage: 86.93% lines/statements, 85.53% branches, 90.79% functions; coordinator and safety gates passed.
`git diff --check` passed. Unrelated pre-existing diffs and the value-panel layout/docking/floating code were compared
with the starting snapshot and remain unchanged. There were no baseline or outstanding test failures.

Real Webview animation and native Canvas timing remain unverified. Bundle is skipped because esbuild is denied in this
sandbox. No E2E, packaging, network, HIL, probe, firmware, driver or release operation is performed.
