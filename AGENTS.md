# Repository Guidelines

## Project Structure & Module Organization

EmberProbe is an ES2022 CommonJS VS Code extension targeting Node.js 20 and VS Code 1.85+. CI uses Node 20 for cross-platform checks and Node 24 for quality and Extension Host tests.

- `src/`: extension entry points, shared validation, ELF/DWARF parsing, and sampling/ELF/SVD Workers.
- `src/services/`: orchestration, hardware operations, session routing, and runtime object reads.
- `src/debug/`: built-in DAP adapter, GDB/MI sessions, scopes, and STL display.
- `src/webview/`: sidebar and live-watch browser assets.
- `skills/<skill-name>/`: bundled `SKILL.md`, scripts, and agent metadata; `skills/_emberprobe/` holds shared Bridge clients and hardware policy.
- `test/`: normal tests; `test/gdb/`: external-toolchain tests; `test/e2e/`: Extension Host tests; `test/hil/`: opt-in hardware tests.
- `scripts/`: build, test, and release utilities; `native/`: Windows driver helper and vendored libwdi; `media/` and `resources/`: icons and bundled tools.

Generated outputs such as `dist/`, `coverage/`, `test-results/`, and `.vscode-test/` must not be manually edited or committed.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set used by CI.
- `npm run check`: syntax-check JavaScript under `src/`, `skills/`, and `scripts/`, then run all normal tests.
- `npm run check:syntax` / `npm run test:unit`: run syntax checks or all normal tests separately.
- `npm run test:fast` / `npm run test:integration`: run the groups defined in `scripts/test-groups.js`.
- `npm run quality`: run ESLint, Prettier checks, JavaScript type-checking, and coverage gates.
- `npm run bundle`: build the extension, debug adapter, Workers, and webview assets; stage the sampling timer dependency.
- `npm run test:e2e`: bundle and run the VS Code Extension Host smoke test.
- `npm run check:release`: run release consistency tests separately from normal tests.
- `npm run package`: create a local validation VSIX in `dist/`; release artifacts are built by CI.
- `npm run test:hil`: run destructive real-board tests; follow `test/hil/README.md` and use dedicated hardware.

## Coding Style & Naming Conventions

Use `require`/`module.exports`, four-space indentation, double quotes, semicolons, LF endings, and a 120-character print width. Prettier and ESLint are authoritative. Use `camelCase` for functions and variables, `PascalCase` for classes, and descriptive kebab-case skill directories.

## Hardware and Data Boundaries

Keep hardware operations behind services and preserve Bridge authentication, input validation, and flash/write/CubeMX authorization. Respect `probeCoordinator` ownership and shared-group leases; preserve cleanup on failures. Bind debug handles and writes to the selected session and stop generation, invalidating stale results after execution or session changes. Preserve byte, traversal, paging, and time budgets for ELF/DWARF, SVD, and runtime objects, including read-only restrictions where type or address identity is uncertain.

Read supporting documents when relevant: `docs/RTOS-AWARENESS.md` and `docs/SHARED-DEBUG-GROUPS.md` for session changes, `docs/CUBEMX-GENERATION.md` for generation, and `docs/JLINK-COMPATIBILITY.md` for probe/driver work. Use `skills/_emberprobe/agent-workflow.md` when changing shared skill behavior; preserve skill-specific authorization requirements.

## Testing Guidelines

Tests are executable Node.js files using built-in `assert`. Name normal tests `test/<feature>.test.js` and register them in `scripts/test-groups.js`; add focused success, failure, and input-validation coverage. Normal tests must not require OpenOCD or a connected probe. The c8 minimums are 80% lines/statements, 75% functions, and 65% branches; `scripts/check-coordinator-coverage.js` also enforces individual service and safety-module gates.

During implementation, run affected tests and broaden checks for changes to shared contracts. Normal tests use local fixtures and may be run and rerun without additional approval. Before submitting code changes, run `npm run check`, `npm run quality`, `npm run bundle`, and relevant E2E tests. For GDB/MI, STL, or image-transfer changes, also run the relevant `test/gdb/` entry points with the toolchain/environment shown in `.github/workflows/ci.yml`. Documentation-only changes need command/link consistency and diff checks.

The normal runner defaults to at most four test processes; use `npm run test:unit -- --jobs 1` for serial diagnosis or `--keep-logs` to retain successful logs. Reports go to `test-results/`. Software tests do not establish real-board support; record hardware validation separately.

## Working Scope and Completion

Do not modify `README.md` unless the user explicitly requests changes to that file. Keep it focused on key capabilities; place detailed usage, implementation, and development documentation in `docs/` or the relevant skill documentation.

Preserve existing uncommitted work. Continue the requested change through implementation, relevant validation, and necessary documentation updates; fix failures caused by the change. Report the resulting behavior, checks performed, and any unavailable toolchain or unverified platform/hardware. A development change does not by itself authorize HIL, driver switching, firmware programming, or publishing a release.

## Commit & Pull Request Guidelines

Use short, imperative subjects, such as `Fix debug session routing`. Reserve `Release EmberProbe vX.Y.Z` for releases. Pull requests should explain behavior and risk, link relevant issues, note tested platforms/hardware, and include screenshots for webview changes.

## Release Process

When preparing a requested release, follow `docs/RELEASING.md`. Start with a non-empty `CHANGELOG.md` Unreleased section; use `release:prepare` to synchronize the five version files and validate them before the release commit. Stable `vX.Y.Z` tags trigger CI to build and publish the VSIX; never re-point a published tag or substitute a locally packaged release artifact. Preserve the bilingual release-note format documented in the release guide.
