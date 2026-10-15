# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is authoritative for conventions (style, testing gates, hardware boundaries, release process, commit style); read it first. This file adds commands and architecture orientation.

## Commands

```sh
npm ci                                   # locked install
npm run check                            # syntax check + all normal tests (= npm test)
npm run check:syntax                     # node --check on src/, skills/, scripts/
npm run test:unit -- --jobs 1            # serial diagnosis (default: up to 4 processes); --keep-logs retains logs
npm run test:fast | test:integration     # groups from scripts/test-groups.js
node test/<name>.test.js                 # run a single test directly (plain node + assert, no framework)
npm run quality                          # eslint + prettier --check + tsc (jsconfig.quality.json) + c8 coverage gates
npm run lint | format | format:check | typecheck
npm run bundle                           # esbuild.js -> dist/ (extension, debug adapter, workers, webview assets)
npm run test:e2e                         # bundle + VS Code Extension Host smoke test (test/e2e)
npm run check:release                    # release consistency tests (separate from normal tests)
npm run package                          # local validation VSIX in dist/
npm run test:hil                         # DESTRUCTIVE real-board tests; only when explicitly asked, see test/hil/README.md
```

- New `test/<feature>.test.js` files must be registered in `scripts/test-groups.js` (explicit membership; `ci-test-topology.test.js` guards this). `test/gdb/` (needs ARM GDB toolchain), `test/e2e/`, and `test/hil/` have their own entry points and are not in normal groups.
- Normal tests must not need OpenOCD or a probe. Reports go to `test-results/`; never edit/commit `dist/`, `coverage/`, `test-results/`, `.vscode-test/`.
- Don't touch `README.md` unless asked (docs go in `docs/` or skill docs).

## Architecture

Plain CommonJS JavaScript (no TypeScript build; types are checked via JSDoc/`tsc` only). The extension (`src/extension.js`) activates a single `MainViewProvider` (`src/mainViewProvider.js`) that wires together everything below. Bundled by esbuild into separate entry points: the extension, the debug adapter (`src/debug/adapter.js`), and Worker threads (`samplingWorker`, `elfWorker`, `svdWorker`, `chartHistoryWorker`).

**Hardware access is layered; keep it that way:**
- `src/probeCoordinator.js` owns probe/OpenOCD access (ownership, shared-group leases, cleanup on failure). Hardware operations go through `src/services/*` (flash, chip info, sampling, fault, CubeMX, etc.), never directly from UI code.
- Sampling (OpenOCD transport + clock) runs in `samplingWorker` so extension-host stalls don't stop acquisition; chart history/archive lives in `chartHistoryWorker` + `src/services/chartHistory*`/`samplingArchive`.
- ELF/DWARF (`src/elf*.js`, `src/dwarf/`) and SVD parsing run in Workers with byte/traversal/paging/time budgets; preserve those budgets and read-only fallbacks when type/address identity is uncertain.

**Built-in debugger (`src/debug/`)**: a DAP adapter over GDB/MI (`mi.js`, `session.js`), with scopes/variables (`variables.js`), STL pretty-printing (`stl.js`). Handles and writes are bound to the selected session and stop generation; stale results must be invalidated after resume/session change. Related services: `debugSessionBridge`, `debugControlService`, `runtimeObjectReader`, `freeRtosSnapshot`, `sharedDebugGroup` (see `docs/RTOS-AWARENESS.md`, `docs/SHARED-DEBUG-GROUPS.md`). Cortex-Debug configs are also supported via `cortexDebugPreflight`; experimental external GDB server in `docs/EXTERNAL-GDB-SERVER.md`.

**Agent Bridge + Skills**: `src/agentBridge.js` / `src/services/agent*.js` expose an authenticated local HTTP bridge. `skills/<name>/` (mcu-flash, mcu-variables, mcu-debug-control, mcu-rtos, mcu-cubemx, …) are bundled Agent Skills installed into user workspaces by `skillInstaller`; `skills/_emberprobe/` holds the shared Bridge client and hardware policy (`agent-workflow.md`). Sensitive operations (flash/program verification, peripheral writes, variable writes, CubeMX) use plan-bound two-stage confirmation in the Agent conversation (`flashAuthorization`, `writeAuthorization`, `peripheralWriteAuthorization`, `cubemxAuthorization`), without a second VS Code operation dialog; see `docs/AGENT-TRUST-BOUNDARIES.md`. Preserve confirmation identity checks, Bridge authentication and input validation (`src/validation.js`).

**UI**: sidebar and live-watch webviews with browser assets in `src/webview/` (`webviewAssets.js`/`webviewTemplate.js`; `mockup/` is a standalone UI mockup). User-visible strings are localized through `src/i18n/` (Chinese primary, English README in `README_EN.md`).

**Other**: `native/` (Windows driver helper, vendored libwdi), `resources/` (bundled tools), `docs/*-AUDIT.md` (past audits, useful for rationale), `docs/RELEASING.md` (release flow: `npm run release:prepare`, bilingual CHANGELOG, tag-triggered CI publish).

Supporting docs to read when relevant: `docs/CUBEMX-GENERATION.md`, `docs/JLINK-COMPATIBILITY.md`, `docs/LAYERED-SAMPLING.md`.
