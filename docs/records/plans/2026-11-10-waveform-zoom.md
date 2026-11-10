# Waveform zoom implementation plan

**Goal:** Repair viewport interaction edge cases and add one-shot/automatic centered and filled Y fitting with view undo.

**Architecture:** Keep numeric range operations in viewport.js. Extract pointer/wheel handling and viewport history into a dedicated browser controller. Reuse committed viewport extrema, preserve raw history, independent raw/normalized Y state, and page zoom capture.

**Tech stack:** CommonJS / browser UMD, canvas, Node assert, jsdom, existing mockup.

1. Add regressions in test/chart-webview.test.js for drag thresholds, axis isolation, long-session follow snapping, clipped sparse segments, and subsecond ticks.
2. Extend viewport.js with fit and visible-extrema helpers; make chart.js render valid crossing segments and adaptive time labels.
3. Extract gestures and bounded view undo into chartViewportController.js. Keep the renderer below its current size ceiling and register the module in webviewTemplate.js.
4. Add four fit actions, explicit Y mode status and keyboard-accessible restore control; retain click-to-freeze and page zoom behavior.
5. Test fit occupancy, negative/constant/large values, no-data behavior, freeze, normalized state, automatic shrink timing and undo.
6. Update docs/guide/waveform.md and docs/design/webview-ui.md. Run focused tests, npm run check, quality, bundle and Extension Host smoke tests because the webview prelude changes. Build and visually inspect the mockup.

The source checkout and its uncommitted changes remain untouched. No hardware operations or publishing are included.

## Completion and validation

Implemented on `codex/waveform-zoom` in the managed `waveform-zoom` worktree. The renderer's counted size fell from 2848 to 2804 lines, and its ceiling was lowered accordingly.

- Regression tests cover the four audit findings, fitting occupancy, negative gain, constant values, null gaps, automatic expansion/contraction, frozen views, raw/normalized state, wheel grouping, bounded undo, keyboard timeline changes and saved preset restoration.
- Windows / Node 24: `npm run check` and `npm run quality` passed. Page zoom, assets and i18n checks passed.
- The unchanged build configuration produced all bundles. Native esbuild output writes were denied in the new directory, so an ignored local helper requested `write: false` and wrote the generated outputs through Node.
- The full existing Extension Host suite passed with cached VS Code 1.136.1. An ignored local runner used an isolated copy of the empty test workspace and isolated user/temp directories under the source checkout's ignored `.vscode-test` directory because native VS Code writes to the new worktree and system temp were denied. The test directories were removed after execution.
- A real Chromium mockup check verified centered occupancy, frozen-state preservation, undo, keyboard menu focus and a 1050-by-800 layout without horizontal overflow. Screenshots are in ignored `output/playwright/`.
- No real-board sampling, firmware programming, HIL, macOS or Linux validation was performed. The changes are uncommitted for review.
