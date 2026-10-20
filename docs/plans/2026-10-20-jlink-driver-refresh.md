# J-Link driver refresh implementation plan

**Goal:** Show the Windows J-Link driver selector after a probe is attached following configuration.

**Architecture:** Reuse read-only USB inventory while the sidebar is visible, with a three-second delay
between completed checks. Recheck retained views on visibility changes and discard superseded scans.
Keep driver installation behind the existing explicit user action and verified interface selection.

**Tech stack:** CommonJS, VS Code WebviewView lifecycle, Node.js timers and assert-based tests.

1. Extend `test/jlink-driver-choice.test.js` with late attachment, removal, overlapping scans,
   visibility, error recovery, driver-switch and monitor cleanup regressions. Verify failures first.
2. Update `src/mainViewProvider.js` to monitor visible Windows sidebars, serialize periodic checks,
   stop monitoring on disposal/shutdown, and reject stale inventory results.
3. Update `docs/JLINK-COMPATIBILITY.md` to describe automatic discovery and its read-only boundary.
4. Run focused tests, `npm run check`, `npm run quality`, `npm run bundle`, and `npm run test:e2e`.
   Review the diff without changing pre-existing work. Record hardware validation separately.

## Validation

- Confirmed the overlapping-scan regression fails before the fix and passes after it.
- Windows x64 / Node 24: `npm run check`, `npm run quality`, and `npm run test:e2e` passed.
  The E2E command includes `npm run bundle`; its successful run used project-local `TEMP` and `TMP`
  because the system temporary directory was not writable by the Extension Host.
- No physical USB attachment or driver installation was performed; hardware validation remains separate.
