# Waveform Panel Identity Implementation Plan

**Goal:** Keep waveform titles unique and restore each tab's own watches after an editor restart.

**Architecture:** Treat the watch-list storage key as the stable chart identity and the panel number as a display label. Reserve numbers and storage identities of hidden VS Code tabs, persist their binding, and recover older tabs from their saved number or localized title. A duplicated saved identity gets an independent copy of its watches and view settings.

**Tech Stack:** CommonJS JavaScript, VS Code Tab Groups and Webview APIs, built-in assert, jsdom.

## Tasks

1. Add regression tests in `test/chart-panel-identity.test.js` for hidden tabs, reversed restore order, legacy state, conflicting numbers, duplicate storage identities, repeated restarts, and message isolation. Register the test in `scripts/test-groups.js`. Confirm failures on the current code.
2. Add `src/services/livePanelRegistry.js` to validate identities, reserve hidden tab numbers, and serialize binding/copy persistence. Integrate it with panel creation, restoration, initialization, and disposal in `src/mainViewProvider.js`.
3. Persist the stable watch key together with the number in `src/liveWatchView.js` and `src/webview/liveWatch/renderer.js`, including at renderer startup. Keep existing numeric watch-list keys compatible.
4. Extend existing host/restore tests and the Extension Host smoke test. Document persistence and migration in `docs/WAVEFORM-PANELS.md`.
5. Run the focused tests, `npm run check`, `npm run quality`, `npm run bundle`, and `npm run test:e2e`. Preserve unrelated work and report unavailable checks.

## Design choices

- Reserving numbers alone fixes duplicate labels but cannot preserve a chart whose number changes.
- Replacing every legacy storage key would require an unnecessary workspace-wide migration.
- Preserve legacy keys and persist their binding to display numbers; use a fresh UUID suffix only when an independent storage identity is needed.

The tab inventory includes hidden editors before webview deserialization. VS Code exposes the internal `mainThreadWebview-` prefix in webview tab inputs; recognize both this form and the public view type. See [tab conversion](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadEditorTabs.ts) and [webview view-type transformation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadWebviewPanels.ts).
