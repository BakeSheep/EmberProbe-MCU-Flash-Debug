# Mockup operation state implementation plan

**Goal:** Make the browser demo follow the extension's probe ownership, sampling, debug pause and cancellation rules.

**Architecture:** Keep hardware-facing extension code unchanged. Add one shared browser coordinator for both mock hosts and the shell. Derive permissions from the current probe operation, debug session and sampling intent; scope asynchronous work to cancellable tasks.

**Tech stack:** ES2022 JavaScript, real EmberProbe webview renderers, Node assert/VM fixtures and jsdom.

## Design

Per-button locks cannot synchronize command-palette commands and two iframe hosts. Reusing the production provider would require VS Code and hardware services. A shared mock coordinator provides the required behavior while retaining the existing real renderers.

- Start with a running target and no debug session. Independent live sampling permits variable writes only while sampling is active.
- A firmware download temporarily suspends requested sampling and restores it after completion. Active debug, CPU sampling, chip reads and driver changes reject a competing firmware download.
- Debug startup suspends independent sampling; a paused session uses DAP snapshots. A running single-core managed session permits read-only OpenOCD sampling. Stopping debug returns consumers to independent sampling.
- Only an active paused debug session permits RTOS and peripheral access. Every execution/session transition invalidates the prior stop generation.
- CPU workload sampling exclusively owns the mock probe. SVD downloads use cancellable tasks separate from probe ownership.
- The shell, sidebar buttons and keyboard commands use the same host operations. Paused data stays stable; browsing a stack cannot pause the target.

## Implementation and validation

1. Add `mockup/mock/coordinator.js`; load it from `mockup/shell/index.html`, copy it through `mockup/build.js`, and exercise it through `test/mockup.test.js`.
2. Update `mockup/mock/sidebar-host.js` and `mockup/mock/livewatch-host.js` to derive state and permissions from the coordinator, cancel timers on destroy, and preserve sampling/history while a temporary operation owns the probe.
3. Update `mockup/mock/prelude.js` and `mockup/shell/shell.js` to reflect authoritative operation availability, unify download entry points, and reconcile debug controls/shortcuts.
4. Extend `test/mockup.test.js` with competing operations in both directions, stop/resume permissions, paused data, CPU ownership, SVD cancellation/retry and detached-host cleanup. Run focused regressions before broad validation.
5. Regenerate the demo with `npm run mockup`; run `node mockup/smoke.js`, `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Verify the generated page in the browser and save screenshots.

No connected hardware, driver switching, firmware programming or release publishing is part of this work. The demo remains a single-core simulation.

## Completion

All implementation steps are complete, including forwarding global shortcuts from both webview iframes. Operation rules and simulation limits are documented in `docs/MOCKUP-OPERATIONS.md`.

- Focused mockup regressions and generated-page smoke checks passed.
- Final Windows checks passed: `npm run check` (374 files), `npm run quality` (including coverage gates), `npm run bundle` and `npm run test:e2e` with VS Code 1.136.1. The normal Windows environment was required for temporary-file and symlink tests; Extension Host temporary files were placed in the workspace.
- Browser verification passed for two-consumer burn suspension/restoration, debug permissions, RTOS snapshots, CPU ownership, SVD cancellation/retry and shortcuts inside both iframes. No browser script errors were recorded. The existing user tab was refreshed with the rebuilt demo.
