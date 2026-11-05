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
npm run bundle                           # esbuild.js -> dist/ (extension, debug adapter, workers)
npm run test:e2e                         # bundle + VS Code Extension Host smoke test (test/e2e)
npm run check:release                    # release consistency tests (separate from normal tests)
npm run package                          # local validation VSIX in dist/
npm run test:hil                         # DESTRUCTIVE real-board tests; only when explicitly asked, see test/hil/README.md
```

- New `test/<feature>.test.js` files must be registered in `scripts/test-groups.js` (explicit membership enforced by `validateGroups`; `test-runner.test.js` also requires the `fast` list to stay alphabetical). `test/gdb/` (needs ARM GDB toolchain), `test/e2e/`, and `test/hil/` have their own entry points and are not in normal groups.
- Normal tests must not need OpenOCD or a probe. Reports go to `test-results/`; never edit/commit `dist/`, `coverage/`, `test-results/`, `.vscode-test/`.
- Don't touch `README.md` unless asked (docs go in `docs/` or skill docs).

## Architecture

Plain CommonJS JavaScript (no TypeScript build; types are checked via JSDoc/`tsc` only). The extension (`src/extension.js`) activates a single `MainViewProvider` (`src/mainViewProvider.js`), which owns the views and event wiring only (layering rules: `AGENTS.md` "Module Boundaries"). Bundled by esbuild into separate entry points: the extension, the debug adapter (`src/debug/adapter.js`), and Worker threads (`samplingWorker`, `elfWorker`, `svdWorker`, `chartHistoryWorker`).

**Composition**: `src/composition.js` (`createServices`) constructs the services the Provider holds. Feature controllers in `src/services/` are reached through Provider accessors created on first use, so `Object.create(Provider.prototype)` tests still work: `_sampling` (`liveWatchController`: read plans, session lifecycle), `_elfView` (`elfViewController`), `_writes` (`writeExecution`), `_agentOps` (`agentOperations`), `_connectedProbes`, `_historyFeed` (`chartHistoryFeed`), plus the public `debugLaunch` (debug start, managed server, shared groups). Pure Agent planning is `agentPlans`; the `download` command is `flashCommand`. Webview messages dispatch through route tables in `src/controllers/` (`sidebarRoutes`, `livePanelRoutes`, shared entries in `webviewRoutes`).

**Hardware access is layered; keep it that way:**

- `src/probeCoordinator.js` owns probe/OpenOCD access (ownership, shared-group leases, cleanup on failure). Hardware operations go through `src/services/*` (flash, chip info, sampling, fault, CubeMX, etc.), never directly from UI code.
- Sampling (OpenOCD transport + clock) runs in `samplingWorker` so extension-host stalls don't stop acquisition; chart history/archive lives in `chartHistoryWorker` + `src/services/chartHistory*`/`samplingArchive`.
- The session (`ManagedOpenOcdSession`, `src/liveWatch.js`) keeps read execution, cadence, read guards and the exclusive arbiter, and composes `tclTransport` (socket, `0x1a` FIFO, timeouts, no-echo detection), `openocdProcess` (launch args, spawn, log tail, stop escalation), `liveWatchReadPlan` (budgets, batch compilation) and `memoryWrite` (natural-width writes with read-back, halt/resume). All time goes through `options.clock` (default `SYSTEM_CLOCK` in `src/samplingClock.js`).
- ELF/DWARF (`src/elf*.js`, `src/dwarf/`) and SVD parsing run in Workers with byte/traversal/paging/time budgets; preserve those budgets and read-only fallbacks when type/address identity is uncertain.

**Built-in debugger (`src/debug/`)**: a DAP adapter over GDB/MI (`mi.js`, `session.js`), with scopes/variables (`variables.js`), STL pretty-printing (`stl.js`). Handles and writes are bound to the selected session and stop generation; stale results must be invalidated after resume/session change. Related services: `debugSessionBridge`, `debugControlService`, `runtimeObjectReader`, `freeRtosSnapshot`, `sharedDebugGroup` (see `docs/design/debug-sessions.md`). GDB toolchain lookup is `debugToolPreflight`.

**Agent Bridge + Skills**: `src/agentBridge.js` / `src/services/agent*.js` expose an authenticated local HTTP bridge. `skills/<name>/` (mcu-flash, mcu-variables, mcu-debug-control, mcu-rtos, mcu-cubemx, …) are bundled Agent Skills installed into user workspaces by `skillInstaller`; `skills/_emberprobe/` holds the shared Bridge client and hardware policy (`agent-workflow.md`). Sensitive operations (flash/program verification, peripheral writes, variable writes, CubeMX) use plan-bound two-stage confirmation in the Agent conversation (`flashAuthorization`, `writeAuthorization`, `peripheralWriteAuthorization`, `cubemxAuthorization`), without a second VS Code operation dialog; see `docs/design/agent-trust-boundaries.md`. Preserve confirmation identity checks, Bridge authentication and input validation (`src/validation.js`).

**UI**: sidebar and live-watch webviews with browser assets in `src/webview/`, served from `src/webview` as shipped (not bundled) by `webviewAssets.js`/`webviewTemplate.js`, so tests, the installed extension and `mockup/` (a standalone UI mockup) run the same scripts. Shared rendering for both pages is the `src/webview/valueTree.js` prelude (`EmberProbeValueTree`), configured per page by an adapter; each page keeps its mutable data in one `state` object (tests read it with `window.eval("state")`). Webview files lint as classic scripts, so an unreferenced top-level function is an error; names only tests use go in `/* exported */`. User-visible strings are localized through `src/i18n/` (Chinese primary, English README in `README_EN.md`).

**Tests**: run production modules with replaced requires through `test/helpers/load-module.js` (`loadProvider` builds on it; `createProvider()` runs the real constructor). Time is driven with `test/helpers/fake-clock.js` through injected clocks (the session's `options.clock`, `render-webview`'s `clock`, which also replaces the page's `Date.now`); real waits use `waitFor` from `test/helpers/wait.js`. Upgrade compatibility layers are registered in `scripts/compat-layers.js`.

**Other**: `native/` (Windows driver helper, vendored libwdi), `resources/` (bundled tools), `docs/records/` (past audits, plans and board validation, useful for rationale), `docs/development/releasing.md` (release flow: `npm run release:prepare`, bilingual CHANGELOG, tag-triggered CI publish).

Supporting docs to read when relevant: `docs/design/`, notably `cubemx-pipeline.md`, `probe-selection.md`, `chart-history.md`.
