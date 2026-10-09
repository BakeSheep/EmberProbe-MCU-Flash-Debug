# Mockup fidelity follow-up implementation plan

**Goal:** Apply the user's four corrections to the browser demo: keep the EmberProbe sidebar selected, remove the memory estimate badge, permit chip information refresh during operations, and reproduce operation output from extension sources.

**Architecture:** Keep the real extension unchanged. The simulated chip information refresh reads the current mock target snapshot without acquiring probe ownership; chip controls retain their existing guards. Generate firmware progress fixtures through the real OpenOCD parser, and route dynamic logs to the terminal, GDB debug console and chip diagnostics output.

**Tech stack:** CommonJS/ES2022, real webview renderers, browser mock hosts, Node assert/VM fixtures and jsdom.

## Tasks

1. Update `mockup/shell/index.html`, `mockup/shell/shell.js` and `mockup/shell/shell-data.js` to lock sidebar navigation to EmberProbe. Remove the Run and Debug sidebar contents, generated launch configuration placeholder and fixed terminal/debug/diagnostic transcripts.
2. Set the mock memory analysis `estimated` metadata to false in `mockup/mock/sidebar-data.js`. Keep accurate memory totals and sections intact.
3. Split chip refresh availability from chip control availability in `mockup/mock/prelude.js` and `mockup/mock/sidebar-host.js`. Deduplicate concurrent refresh clicks, publish current target information at completion, and preserve running operations, their generations and sampling timers.
4. Create `mockup/mock/operation-output.js` with source-derived operation fixtures. Have `mockup/build.js` generate the browser fixture from the real `src/openocdRunner.js` parser. Route flash progress and summary to `EmberProbe OpenOCD`, GDB console output to the debug console, current chip diagnostics to the output panel and actual sampling/CPU/SVD state messages to the EmberProbe output channel.
5. Extend `test/mockup.test.js` for chip refresh during sampling, flash, debug startup, paused/running debug, CPU and driver operations; verify locked sidebar navigation, no launch configuration, no stale prefabricated success output, ordered progress, replay history and cancellation. Update `mockup/smoke.js` and `docs/MOCKUP-OPERATIONS.md`.
6. Run focused tests, rebuild and smoke-test the demo, then complete `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Verify generated output and concurrent refresh in the browser, refresh the user's existing page and save a screenshot.

## Source references

- `src/openocdRunner.js`: `parseLine`, `printEvent`, shared terminal name and final firmware summary.
- `src/liveWatch.js`: `lw.connecting`, `lw.connected` and runtime sampling status.
- `src/debug/session.js` / `src/debug/mi.js`: GDB console output forwarding through DAP `OutputEvent`.
- `src/mainViewProvider.js`: `_writeChipDiagnostics` output format and output-channel name.
- `src/i18n/zh.js`: operation status and diagnostic text.

No hardware operations, production permission changes, release or publishing work are included.

## Completion

All six tasks are complete. The original localhost demo tab is refreshed with the rebuilt assets and shows the completed firmware terminal output alongside the EmberProbe sidebar.

- `node test/mockup.test.js` passed, including concurrent chip refresh in all eight operation states, deduplication, current target state, parser-derived progress order, terminal history and cancellation / disposal.
- `npm run mockup` and `node mockup/smoke.js` passed; all 19 shell asset references exist.
- `npm run check` passed: 375 test files, zero failures.
- `npm run quality` passed: ESLint, Prettier, JavaScript type checking, 175 quality test files and coverage / safety gates. Overall coverage: 86.07% lines and statements, 91.6% functions, 83.48% branches.
- `npm run bundle` and `npm run test:e2e` passed on Windows with Node.js 24.13.1 and VS Code 1.136.1. Extension Host exited with code 0; its temporary data was kept under `test-results/mockup-e2e-temp`.
- Browser verification covered sampling and flash with concurrent chip refresh, debug startup / running / paused reads, continue / pause / step / stop console output, CPU load results and SVD download status. Both the test tab and original tab reported no browser errors.
- Final screenshot: `C:/Users/28951/.codex/visualizations/2026/10/09/01a12091-a2ed-7771-b9d5-d008d4e504d1/mockup-fidelity-final.jpg`.

All output data remains simulated. No real probe, driver or target firmware operation was performed.
