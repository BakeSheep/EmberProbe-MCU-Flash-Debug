# VS Code fidelity and themes implementation plan

**Goal:** Match the Windows VS Code workbench's Dark Modern and Light Modern appearance, replace approximate icons, and keep ELF memory totals stable across refreshes.

**Architecture:** Vendor the official Codicon font, logo and theme color snapshots with attribution. Keep the existing shell and real extension renderers; switch CSS variables in place and synchronize themes across iframe boundaries without remounting hosts. Float debugger controls over the top tab strip at the native 35px window offset, use Monaco-style glyph margins and preserve the existing stop generations.

**Tech stack:** CommonJS build scripts, browser JavaScript, CSS custom properties, jsdom and the existing Node test runner.

1. Vendor matching icon/font resources and Modern theme colors from the local VS Code 1.136.1 test installation. Record origins and licenses in `mockup/vendor/README.md`; stage the assets through `mockup/build.js`.
2. Update `mockup/shell/index.html`, `shell.js` and `shell.css`: official activity/title/status/debug icons; top-of-workbench debugger controls; correctly sized breakpoint/execution glyph margin; matching tab, menu and control metrics.
3. Add `mockup/mock/theme.js`, Light Modern variables and theme commands. Persist only the selected theme, propagate validated parent messages and repaint frozen charts without replacing frames or losing samples.
4. Remove randomized memory changes in `mockup/mock/sidebar-host.js`. Test repeated refreshes against the same fixed ELF fixture.
5. Extend `test/mockup.test.js` to verify theme synchronization, frame/state preservation, debug controls and stable memory totals. Document the theme controls and exact demo limits.
6. Generate/smoke the demo, run check/quality/bundle/E2E and inspect both themes, debugger controls and short-window waveform/export layouts in a real browser. Keep all changes uncommitted.
