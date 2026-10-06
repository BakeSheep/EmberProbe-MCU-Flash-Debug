# Mockup repair plan

Goal: repair the eleven reviewed demo regressions without changing hardware-facing extension behavior.

Architecture: keep the real webview renderers and their in-place language switching. Share one variable simulator between the two mock hosts; keep sampling archives in the Live Watch host with a bounded history. Reuse the extension's CSV serializer through a generated browser asset. Separate shell execution position from selected-file navigation.

1. Add `test/mockup.test.js` to the integration group. Exercise the actual host message handlers, shell interactions, and HTTP server with local fixtures; do not require generated files or hardware.
2. Repair simulator writes and register field masks, preserving unrelated values and validating unsupported/read-only targets.
3. Repair host sampling, sidebar imports, bounded CSV archives, and chip-state reads. Preserve session stop generations.
4. Repair shell file rendering, stepping, breakpoint clicks, language preservation, and toolbar placement. Cover empty/closed tabs and file-specific breakpoints.
5. Harden malformed URL and path handling in `mockup/serve.js`; update demo documentation and smoke coverage.
6. Run the focused regression test, demo generation/smoke, `npm run check`, `npm run quality`, `npm run bundle`, and Extension Host E2E. Verify the real browser at desktop and narrow-window sizes and record any unavailable validation.
