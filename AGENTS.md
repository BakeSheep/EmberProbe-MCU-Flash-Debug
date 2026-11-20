# Repository Guidelines

## Project Structure & Module Organization

EmberProbe is an ES2022 CommonJS extension for VS Code 1.85+. Use Node.js 24 LTS for local development, CI, and packaging. The shipped bundles target the Node.js 18 runtime included in VS Code 1.85.

- `src/` contains extension entry points, the composition root (`composition.js`), shared validation, ELF/DWARF parsing, and Workers for sampling, ELF, SVD, and chart history.
- `src/services/`: orchestration, feature controllers, hardware operations, session routing, and runtime object reads.
- `src/controllers/`: webview message routes keyed by message type.
- `src/debug/`: built-in DAP adapter, GDB/MI sessions, scopes, and STL display.
- `src/mcp/` contains the MCP stdio server, tool schemas, prompts, confirmation handling, and result formatting.
- `src/webview/` contains the sidebar, live-watch, and RTT terminal browser assets. The extension ships and serves these files directly.
- `skills/<skill-name>/`: bundled `SKILL.md`, scripts, and agent metadata; `skills/_emberprobe/` holds shared Bridge clients and hardware policy.
- `test/`: normal tests; `test/gdb/`: external-toolchain tests; `test/e2e/`: Extension Host tests; `test/hil/`: opt-in hardware tests.
- `scripts/` contains build, test, and release utilities. `native/` contains the Windows driver helper and vendored libwdi. `native/openocd/` holds the build lock, patches, and corresponding source archive for bundled OpenOCD. `media/` and `resources/` contain icons and bundled tools.
- `website/` contains the public product site and guided tutorials. `mockup/` runs browser previews of the extension UI with simulated data. See [website development](docs/development/website.md).

Generated outputs such as `dist/`, `coverage/`, `test-results/`, and `.vscode-test/` must not be manually edited or committed.

## Module Boundaries

`MainViewProvider` owns only the views' lifecycle and event wiring. `src/composition.js` constructs the services it holds; feature logic belongs in a controller or service under `src/services/` (for example `liveWatchController`, `debugLaunch`, `writeExecution`, `agentOperations`), reached through the Provider's accessor for it. Do not add feature methods or state to the Provider.

Add each Webview message to its route table in `src/controllers/`. Use `sidebarRoutes.js` for the sidebar, `livePanelRoutes.js` for Live Watch, `rttPanelRoutes.js` for the RTT terminal, and `webviewRoutes.js` for messages shared by the sidebar and Live Watch. Keep shared value formatting, pointer state, and value trees in `src/webview/valueTree.js`, with page-specific behavior supplied through its adapter. Each page keeps its mutable data in one `state` object.

The OpenOCD session in `src/liveWatch.js` composes `tclTransport` (Tcl connection), `openocdProcess` (server process), `liveWatchReadPlan` (pure read planning) and `memoryWrite` (write transactions); extend the module that owns the concern. Code that measures or waits on time takes it from an injected clock (`SYSTEM_CLOCK` in `src/samplingClock.js` by default) so tests can drive it.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set used by CI.
- `npm run check` syntax-checks JavaScript under `src/`, `skills/`, `scripts/`, and `mockup/` (excluding `mockup/dist/`), plus top-level JavaScript in `website/`. It then runs all normal tests.
- `npm run check:syntax` / `npm run test:unit`: run syntax checks or all normal tests separately.
- `npm run test:fast` / `npm run test:integration`: run the groups defined in `scripts/test-groups.js`.
- `npm run quality`: run ESLint, Prettier checks, JavaScript type-checking, and coverage gates.
- `npm run bundle` builds the extension, debug adapter, MCP server, and the sampling, ELF, SVD, and chart-history Workers. It also stages the sampling timer dependency.
- `npm run test:e2e`: bundle and run the VS Code Extension Host smoke test.
- `npm run check:release`: run release consistency tests separately from normal tests.
- `npm run package`: create a local validation VSIX in `dist/`; release artifacts are built by CI.
- `npm run test:hil`: run destructive real-board tests; follow `test/hil/README.md` and use dedicated hardware.

## Coding Style & Naming Conventions

Use `require`/`module.exports`, four-space indentation, double quotes, semicolons, LF endings, and a 120-character print width. Prettier and ESLint are authoritative. Use `camelCase` for functions and variables, `PascalCase` for classes, and descriptive kebab-case skill directories.

`eslint.config.js` caps files at 1500 lines and non-webview functions at 300 lines (blank lines and comments excluded); the few larger files and functions carry their current size as a ceiling. Ceilings only go down: lower the entry in the change that shrinks the code and delete it once the code is under the default. Split code instead of raising a ceiling.

Follow the [EmberProbe UI copy guidelines](docs/development/ui-copy.md) when writing or revising user-facing extension text.

## Hardware and Data Boundaries

Keep hardware operations behind services and preserve Bridge authentication, input validation, and flash/write/CubeMX authorization. Respect `probeCoordinator` ownership and shared-group leases; preserve cleanup on failures. Bind debug handles and writes to the selected session and stop generation, invalidating stale results after execution or session changes. Preserve byte, traversal, paging, and time budgets for ELF/DWARF, SVD, and runtime objects, including read-only restrictions where type or address identity is uncertain.

Read supporting documents when relevant: `docs/design/debug-sessions.md` for session changes, `docs/design/cubemx-pipeline.md` for generation, and `docs/design/probe-selection.md` for probe/driver work. Use `skills/_emberprobe/agent-workflow.md` when changing shared skill behavior; preserve skill-specific authorization requirements.

## Testing Guidelines

Tests are executable Node.js files using built-in `assert`. Name normal tests `test/<feature>.test.js` and register them in `scripts/test-groups.js`; add focused success, failure, and input-validation coverage. Add a fix or new behavior as a `scenario(...)` (`test/helpers/scenario.js`) in the module's existing test file; create a new test file only for a new module. Shared builders belong in `test/helpers/` (`elf-fixture`, `dwarf-tree`, `memory-fixture`, `render-webview`, `chart-history-host`, `fake-clock`, `fake-openocd-server`, `load-module`, `wait`); `test-helper-reuse.test.js` rejects local copies of the binary builders, wait helpers and module loaders. Drive timers with `FakeClock` through an injected clock instead of sleeping; where a test must cross a Worker, child process or file I/O, wait for a condition with `waitFor` rather than a fixed delay. `i18n-keys.test.js` rejects unreferenced and undefined i18n keys, so delete a key in the change that stops using it. Normal tests must not require OpenOCD or a connected probe. The c8 minimums are 80% lines/statements, 75% functions, and 65% branches; `scripts/check-coordinator-coverage.js` also enforces individual service and safety-module gates.

During implementation, run affected tests and broaden checks for changes to shared contracts. Normal tests use local fixtures and may be run and rerun without additional approval. Before committing, scale verification to the change:

- Documentation only: command/link consistency and diff checks.
- Local change in one module or Webview page: affected tests plus `npm run check`.
- Shared contracts, composition, Agent Bridge or MCP, probe or session paths, `package.json`, or bundled entry points: also `npm run quality`, `npm run bundle`, and relevant E2E tests.
- GDB/MI, STL, or image-transfer changes: also the relevant `test/gdb/` entry points with the toolchain/environment shown in `.github/workflows/ci.yml`.
- Before opening a pull request or preparing a release: the full set, regardless of size. CI runs it on every push to `master`.

The normal runner defaults to at most four test processes; use `npm run test:unit -- --jobs 1` for serial diagnosis or `--keep-logs` to retain successful logs. Reports go to `test-results/`. Software tests do not establish real-board support; record hardware validation separately.

## Working Scope and Completion

Do not modify `README.md` unless the user explicitly requests changes to that file. Keep it focused on key capabilities; place detailed documentation in `docs/` or the relevant skill documentation.

Organize `docs/` by reader; `docs/guide/` is for users: what a feature does, how to use it, limits, and troubleshooting. It never covers internal modules, data formats, or how a behavior was tested. It is Chinese, flat, and at most seven pages: extend an existing page instead of adding one. `docs/design/` is written in Chinese for contributors and coding agents. It explains architecture, invariants, design rationale, and validation boundaries. `docs/development/` covers contributor workflows. `docs/records/` is a Git-ignored local directory for historical evidence. Append dated results to an existing record for the same topic, retaining the environment, result, and limits. Keep routine test output in `test-results/` and remove completed plans once the design and any reusable evidence are documented.

Preserve existing uncommitted work. Continue the requested change through implementation, relevant validation, and necessary documentation updates; fix failures caused by the change. Report the resulting behavior, checks performed, and any unavailable toolchain or unverified platform/hardware. A development change does not by itself authorize HIL, driver switching, firmware programming, or publishing a release.

## Commit & Pull Request Guidelines

Use short, imperative subjects, such as `Fix debug session routing`. Reserve `Release EmberProbe vX.Y.Z` for releases. Pull requests should explain behavior and risk, link relevant issues, note tested platforms/hardware, and include screenshots for webview changes.

## Release Process

When preparing a requested release, follow `docs/development/releasing.md`. Start with a non-empty `CHANGELOG.md` Unreleased section; use `release:prepare` to synchronize the five version files and validate them before the release commit. Stable `vX.Y.Z` tags and prerelease `vX.Y.Z-alpha.N`/`-beta.N`/`-rc.N` tags trigger CI to build and publish the VSIX (prereleases as GitHub Pre-releases); never re-point a published tag or substitute a locally packaged release artifact. Preserve the bilingual release-note format documented in the release guide.

Compatibility layers kept for upgrades are registered in `scripts/compat-layers.js` with the release that removes them. Register any new one; remove the code and its entry before that release, or the release consistency test fails.
