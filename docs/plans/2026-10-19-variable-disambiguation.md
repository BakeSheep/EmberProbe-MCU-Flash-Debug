# Variable disambiguation implementation plan

**Goal:** Treat same-named variables in separate compilation units as normal list entries, and ask for a source only when a typed name is ambiguous.

**Architecture:** Preserve canonical symbol identities and the shared resolver's rejection of ambiguous reads/writes. Remove the automatic same-name warning from ELF loading. Render readable variable names with muted source labels, and use the existing live-watch combobox for explicit candidate selection. Candidate replies must match the current ELF and input request.

**Tech stack:** CommonJS, existing webview DOM/CSS, Node assert and JSDOM.

1. Update `src/services/elfService.js` to stop emitting automatic same-name warnings. Make explicit diagnostic text in `src/elfSymbols.js` prefer DWARF display names; keep raw identities in structured candidate metadata.
2. Add a shared scoped-name renderer in `src/webview/runtime.js`, used by sidebar available variables, waveform import and autocomplete. Show the readable name first and a muted shortest unique file suffix; keep full source/address in the tooltip.
3. Return structured ambiguity candidates from `src/mainViewProvider.js`. Keep the typed query, open the existing combobox with a localized selection hint, and require an explicit mouse/keyboard choice. Reject stale replies after an input edit, cancellation, or ELF change.
4. Extend focused parser, host and webview tests for readable candidates, no automatic warning, source labels, keyboard/mouse selection, stale responses and continued rejection of ambiguous reads/writes. Register the new test in `scripts/test-groups.js`.
5. Run affected tests, inspect the real H750 ELF, and verify browser layout in light/dark themes. Run `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Record hardware separately; this change does not require hardware operations.

## Verification — 2026-10-19

- Windows x64, Node 24.13.1: `npm run check` passed (403 files); `npm run quality` passed (196 test files, all coverage gates).
- `npm run test:e2e` passed, including its production bundle and Extension Host tests. Local validation used a repository-local temporary directory outside the filesystem sandbox because sandboxed rename/symlink operations returned EPERM.
- The first coverage run hit an existing CubeMX cancellation test's temporary-script EEXIST race; a complete quality rerun passed without changes to CubeMX.
- `node test/gdb/cu-static-variables.test.js` passed with the installed ARM GCC toolchain.
- Parsed the existing `H750_RTOS_CPP_Test.elf`: all four source-qualified variables retained their readable names, addresses and types; automatic warnings were empty. Browser checks covered source labels in light/dark themes and explicit keyboard selection using these real ELF records with a local mock host. No board access was used.
- Focused tests cover editable input, mouse/keyboard selection, no default candidate, language changes, stale ELF/input/request responses, focus protection, and unusable symbol identities. See `docs/VARIABLE-NAMES.md` for the resulting interaction.
