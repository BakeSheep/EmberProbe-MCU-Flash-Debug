# Mockup Output and Driver Correction Implementation Plan

**Goal:** Match the user's desktop experience by removing EmberProbe content from the demo Output panel and exposing a functional J-Link driver selector that requires WinUSB for target operations.

**Architecture:** Keep the extension and native driver helper unchanged. Reuse the real sidebar driver dropdown and busy indicator. Track the confirmed simulated USB driver in the shared coordinator; verify the requested value, keep the previous choice while switching, and enforce the same unsupported-driver error across every target entry point. Retain firmware terminal output and GDB console output; sampling, CPU, SVD and chip-read status stays in the sidebar.

**Tech Stack:** CommonJS / ES2022, existing VS Code shell, actual webview renderers, Node assert / VM fixtures and jsdom.

## Tasks

1. Remove invented Output-channel buffers, dropdown options and host output emissions from `mockup/shell/index.html`, `mockup/shell/shell.js`, `mockup/mock/sidebar-host.js`, `mockup/mock/livewatch-host.js` and `mockup/mock/operation-output.js`. Preserve the standard empty Output panel and operation-specific terminal / debug console.
2. Enable `showJlinkDriverChoice` in `mockup/build.js`, use the label `J-Link · SWD`, and keep MCU configuration expanded by default so the real driver selector is visible. Replay the current confirmed driver and busy state on initialization.
3. Extend `mockup/mock/coordinator.js` with a confirmed `winusb` / `segger` driver state. SEGGER blocks target operations, sampling, CPU measurement, chip refresh and chip control with `PROBE_DRIVER_UNSUPPORTED`; driver changes remain possible when the probe is idle. Existing operation locks still prevent a driver change during sampling, flash, debug or CPU measurement.
4. Validate driver selections in the sidebar host. Same-driver selection is a no-op; valid changes simulate restoring / installing, keep the confirmed selection until completion, then publish the new choice and warning / readiness. Invalid or busy requests restore the actual selector and never claim success. Switching is entirely simulated.
5. Update `test/mockup.test.js` for visible driver controls, no invented Output content, invalid / duplicate / busy selections, confirmed-driver timing, SEGGER rejection across both hosts, WinUSB recovery, concurrent chip refresh, initialization replay and disposal. Update `mockup/smoke.js` and `docs/MOCKUP-OPERATIONS.md`.
6. Run `node test/mockup.test.js`, `npm run mockup`, `node mockup/smoke.js`, `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Verify driver switching and the empty Output panel in a browser, refresh the user's page and save a screenshot.

## Source References

- `docs/JLINK-COMPATIBILITY.md`: WinUSB requirement; SEGGER option restores an existing driver backup and does not enable EmberProbe target operations.
- `src/modernView.js`: the driver selector beside Select Debugger.
- `src/webview/sidebar/renderer.js`: confirmed driver, busy indicator, restoring / installing statuses and unsupported-driver text.
- `src/mainViewProvider.js::_changeJlinkDriver`: validation, ownership guard, driver verification and warning.
- `src/services/probeDriverService.js`: restoring / restored and installing / ready state pairs.

No real driver changes, probe access, firmware operations, releases or publishing are included.

## Completion

All six tasks completed on Windows with Node.js 24.13.1. The focused mockup regressions, generated-page smoke checks, `npm run check` (375 files), `npm run quality` (175 files and coverage gates), `npm run bundle` and VS Code 1.136.1 Extension Host tests passed. The first Extension Host launch crashed inside the restricted execution environment; the isolated rerun with normal process access passed.

Browser verification confirmed visible WinUSB / SEGGER selection, the previous confirmed value during switching, unsupported-driver feedback and disabled target actions under SEGGER, recovery to WinUSB, sampling / CPU driver locks and an empty Output panel. The original user tab was refreshed and left using WinUSB. A screenshot was saved in the task's visualization directory. All operation and driver transitions remain simulated; no hardware validation was performed.
