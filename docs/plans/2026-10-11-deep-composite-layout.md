# Deep composite layout implementation plan

> **For Claude:** Execute the implementation and verification in the current working tree; preserve all existing edits and do not commit.

**Goal:** Resolve issue #28 without hiding healthy siblings when C++ layouts exceed a branch limit.

**Architecture:** Build bounded partial layouts with stable unobservable codes and a propagated truncated flag. Cache only complete subtrees with build depth and original node/byte-room checks. Keep expansion requests scoped to the ELF Worker generation and preserve all hardware/write authorization.

**Tech Stack:** ES2022 CommonJS, Node assert tests, Worker threads, localized sidebar/live-watch renderers.

## 1. Builder and cache

- Modify src/dwarf/types.js and shared layout limits: iterate alias chains, count composite levels, remove the dead member depth guard, reserve sibling rows and allocate expansion work across branches.
- Truncate depth, node-budget and by-value cycles independently. Keep hard errors for roots whose own rows cannot fit.
- Add complete-only cache entries with build depth, cost and original nodeRoom/byteRoom; reuse requires the original room, not merely fitting the cost. Compare same-name candidates using fresh identical budgets.
- Extend test/dwarf-budget.test.js and add test/dwarf-deep-layout.test.js for variant-like inheritance, aliases, cycles, sibling preservation, cache order and eviction.

## 2. Consumers and runtime

- Audit src/compositeValidation.js, src/elfSymbols.js, src/validation.js, services, Bridge/write targets and both webview renderers. Skip unavailable nodes before decoding, leaf generation or write/watch targeting.
- Display named unavailable rows using English/Chinese translations and update docs/UI-MESSAGES-CATALOG.md.
- Modify src/dwarf/runtimeTypes.js and runtime readers to retain a bounded root graph with unavailable branches, preserving atomic dynamic-identity catalogs.

## 3. Lazy expansion API

- Add validated opaque handles in src/elfWorker.js after candidate identity comparisons. Scope handles to one Worker generation and expose bounded fresh-budget sublayout requests through src/services/elfService.js.
- Reject invalid/stale handles and do not cache them as symbol layout failures. Add round-trip and invalidation tests.
- UI lazy expansion is completed in the continuation below, using detached subroots and a bounded, generation-validated sampling/path model.

## 4. Documentation and verification

- Register new tests in scripts/test-groups.js and document limits and partial-layout semantics in docs/DWARF-LAYOUT-RESOLUTION.md.
- Run focused Node tests, then npm run check and npm run quality; use Prettier only on files changed for this task.
- Run bundle and relevant software E2E checks. Keep generated output out of the user-protected dist/, coverage/ and test-results/ directories by running gates against an exact temporary source mirror.
- Report exact command results and any unavailable environment, toolchain or UI expansion work.

## Execution results (2026-10-11)

Validation ran on Windows with Node 24.13.1 in isolated source copies. The repository's original
dist/, coverage/, test-results/ and README.md were not written by this task. No commit, push or HIL
operation was performed.

| Command | Result |
| --- | --- |
| npm run check | PASS: 376 files checked; 0 failed |
| npm run quality | PASS: lint, formatting, type checking and coverage gates; 86.36% lines/statements, 91.42% functions, 83.64% branches |
| node test/dwarf-deep-layout.test.js | PASS |
| node test/dwarf-layout-expansion.test.js | PASS |
| node test/gdb/runtime-objects.test.js | PASS: compiler-generated ARM libstdc++ layouts, DWARF 4 and 5 |
| node test/gdb/printer-modes.test.js | PASS: builtin/raw/GDB printers and initialization fallback |
| node test/gdb/enum-variables.test.js | PASS: ARM C/C++ DWARF 2/4/5, normal and short enum storage |
| npm run bundle | FAIL: native esbuild cannot read a parent directory in this environment |
| npm run test:e2e | FAIL at the same pre-test bundle step; Extension Host did not launch |
| git diff --check | PASS |

The native paused-GDB matrix passed all four combinations of CPP_STANDARD=17/20 and CPP_DWARF=4/5
using MinGW GCC 15.2.0 and GDB 16.3. Exact invocation for each combination:

- node -e 'process.env.CPP_STANDARD="17";process.env.CPP_DWARF="4";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="17";process.env.CPP_DWARF="5";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="20";process.env.CPP_DWARF="4";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="20";process.env.CPP_DWARF="5";require("./test/gdb/cpp-paused.test.js");'

ARM fixture checks used Arm GNU Toolchain 15.2.Rel1 (GCC 15.2.1). The native bundle error occurred in
both a temporary source copy and a copy under .vscode-test:

> Cannot read directory "../../../..": Access is denied.

A write:false in-memory build of src/dwarf/layoutLimits.js from the original repository also failed
with Cannot read directory "../..": Access is denied. This confirms the native filesystem limitation
without modifying original generated output. No project build configuration was changed. Linux,
macOS, GCC 14, Node 20 and real hardware were not validated in this session.

At the end of this first stage, the Worker/service on-demand API was complete and UI expansion was
deferred. The continuation below completes the detached UI, path, read/watch and typed-write model.

## Files changed by this task

The changes below were layered onto the existing working tree.

- src/dwarf/types.js
- src/dwarf/runtimeTypes.js
- src/dwarf/layoutLimits.js (new)
- src/dwarf/layoutExpansion.js (new)
- src/dwarf.js
- src/elfWorker.js
- src/services/elfService.js
- src/services/runtimeObjectReader.js
- src/compositeValidation.js
- src/elfSymbols.js
- src/validation.js
- src/webview/runtime.js
- src/webview/sidebar/renderer.js
- src/webview/liveWatch/renderer.js
- src/i18n/en.js
- src/i18n/zh.js
- scripts/test-groups.js
- test/dwarf-budget.test.js
- test/dwarf-deep-layout.test.js (new)
- test/dwarf-layout-expansion.test.js (new)
- test/dwarf-audit-regressions.test.js (existing in-progress file)
- test/elf-webview-lazy.test.js
- docs/DWARF-LAYOUT-RESOLUTION.md (existing in-progress file)
- docs/UI-MESSAGES-CATALOG.md
- docs/plans/2026-10-11-deep-composite-layout.md (new)

## UI on-demand continuation (2026-10-11)

- Preserve the reviewer cache-room fix (depth, original nodeRoom and byteRoom; no layoutHeight).
- Keep bounded roots immutable. Store detached sublayouts on each symbol in a generation-scoped path map; validate each subroot against the original branch size, and bound total expansions, serialized bytes and consumer visits.
- Share branch substitution between host path resolution and both webviews. Account for all member/base offsets and concrete array indices before entering a subroot. Type cycles and unresolved locations remain unavailable.
- Validate and de-duplicate UI expansion requests, bind the signed handle to the exact reachable symbol path, and broadcast successful expansions to sidebar/live-watch views. Localize loading, stale and budget/error states.
- Resolve read/watch/Bridge paths through this map. Keep typed static writes behind existing RAM, type and writeAuthorization checks; runtime/STL writes stay refused.
- Invalidate all maps on generation change. Never persist handles/subroots; reloaded watches must re-resolve from current metadata or be reported invalid.
- Add focused plain-Node tests for UI, request validation, array/base offsets, decode/read plans, watches, recursion/caps and writes; register them. Update the layout-resolution document and message catalog.
- Run affected tests, then npm run check, npm run quality, npm run bundle, npm run test:e2e and git diff --check. Run generated-output gates in an exact isolated source mirror so original protected directories remain untouched.

## UI continuation final design (2026-10-12)

UI expansion is complete in both localized webviews, including member browsing/import, selected
composite trees and static storage leaves beneath semantic STL roots. Loading, retry, stale ELF,
per-symbol limits and invalid reloaded-watch states use the shared message catalog. Type cycles
remain unavailable. Anonymous expanded branches keep a concrete .? identity through decoded
samples and UI value updates.

Each symbol keeps a detached path -> sublayout map scoped to the Worker generation. The cached
root is unchanged. Handle requests are validated and bound to the exact reachable member path;
addresses come from the symbol base plus all member/base offsets and concrete array-index strides,
then offsets within the detached subroot. Nested expansions share a cap of 32 subroots and 8 MiB
of serialized metadata per symbol, with pending count reservations and aggregate consumer visit/
depth checks. Service request limits and each subroot's original build limits remain intact.

Watch normalization, read plans, decoding/history and Bridge reads/watch additions use these maps.
Expanded static leaves below STL roots read only verified by-value storage; no active variant
alternative is inferred. Static metadata maps stay out of runtime hardware-read plans. Ordinary
static scalar writes use the existing typed RAM checks and full writeAuthorization confirmation
fingerprints; symbols with runtime/STL recipes still refuse writes, including expanded leaves.
Bridge authentication and validation are unchanged. No Bridge expansion endpoint was added: agents
must ask for UI expansion before reading/watching a path beneath a truncated branch.

Save and reload rebind persist only canonical name/path, type preference, optional bitfield selection
and the expanded-path marker, retaining existing user write-input range/value preferences. They never
persist addresses, sizes, layouts, handles or runtime
graphs. Generation changes clear maps and pending requests, and late UI replies are ignored even
for the same ELF hash. Reloaded watches survive only by safely resolving against current metadata;
unavailable expanded paths are removed and reported. No old address or handle is replayed.

The reviewer cache condition (depth <= cached.depth and remaining nodes/bytes >= original
nodeRoom/byteRoom) remains unchanged, with layoutHeight absent. The only continuation change in
test/dwarf-deep-layout.test.js supplies the shared consumer helpers to its extracted-function fixture.

### Continuation files changed

- src/webview/runtime.js
- src/elfSymbols.js
- src/validation.js
- src/services/elfService.js
- src/services/liveWatchService.js
- src/services/watchListStore.js
- src/mainViewProvider.js
- src/webview/sidebar/renderer.js
- src/webview/liveWatch/renderer.js
- src/i18n/en.js
- src/i18n/zh.js
- scripts/test-groups.js
- test/dwarf-deep-layout.test.js
- test/helpers/layout-expansion-fixture.js
- test/layout-expansion-paths.test.js
- test/layout-expansion-ui.test.js
- test/layout-expansion-host.test.js
- src/webview/sidebar/app.css
- src/webview/liveWatch/app.css
- docs/UI-MESSAGES-CATALOG.md
- docs/DWARF-LAYOUT-RESOLUTION.md
- docs/plans/2026-10-11-deep-composite-layout.md

### Continuation verification results

Final source validation used Windows, Node 24.13.1 and an exact temporary source mirror. The original
README.md, dist/, coverage/ and test-results/ were not written. No revert/stash/reset/checkout,
commit, push or HIL operation was performed. No safety or coverage threshold was lowered.

| Command | Final result |
| --- | --- |
| npm run check | PASS: 379 files checked; 0 failed |
| npm run quality | PASS: lint, formatting, type checking, 180 coverage tests and service/safety gates; 86.26% lines/statements, 91.37% functions, 83.70% branches |
| node test/layout-expansion-host.test.js | PASS: validation/broadcast, actual Worker recursive windows and stale generations |
| node test/layout-expansion-paths.test.js | PASS: member/base/array offsets, decode/read/history, static STL leaves, watches, identity-only reload rebind, caps and authorized/refused writes |
| node test/layout-expansion-ui.test.js | PASS: both languages and webviews, static/STL roots, nested load, error/stale states, selection and anonymous-branch value updates |
| node test/dwarf-deep-layout.test.js | PASS: reviewer cache-room regression retained |
| node test/composite-decode.test.js | PASS |
| node test/gdb/runtime-objects.test.js | PASS: compiler-generated ARM runtime layouts, DWARF 4 and 5 |
| node test/gdb/printer-modes.test.js | PASS: builtin/raw/GDB modes and initialization fallback |
| node test/gdb/enum-variables.test.js | PASS: ARM C/C++ DWARF 2/4/5, normal and short enum storage |
| npm run bundle | FAIL: native esbuild parent-directory access denied by the sandbox filesystem |
| npm run test:e2e | FAIL at the same pre-test bundle step; Extension Host did not launch |
| git diff --check | PASS |

All four paused-GDB software matrix commands passed with MinGW GCC 15.2.0 and GDB 16.3:

- node -e 'process.env.CPP_STANDARD="17";process.env.CPP_DWARF="4";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="17";process.env.CPP_DWARF="5";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="20";process.env.CPP_DWARF="4";require("./test/gdb/cpp-paused.test.js");'
- node -e 'process.env.CPP_STANDARD="20";process.env.CPP_DWARF="5";require("./test/gdb/cpp-paused.test.js");'

The latest bundle/E2E attempts reproduce the first-stage native failure before entry points are read:
Cannot read directory "../../../..": Access is denied. The entry-point files exist and final
syntax/type checks pass. No build configuration was changed to bypass this restriction. Bundle and
Extension Host verification require a reviewer rerun outside this filesystem restriction. The UI
and detached read/watch implementation has no remaining deferred work; runtime/STL writes remain
intentionally refused. ARM fixtures used Arm GNU Toolchain 15.2.Rel1. Linux/macOS, Node 20 and real
hardware were not validated in this session.
