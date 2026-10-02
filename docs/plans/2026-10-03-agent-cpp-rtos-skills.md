# C++ / RTOS Agent Skills adaptation

## Findings and implementation

| Capability | Existing skill behavior | Adaptation |
| --- | --- | --- |
| C++ session control and breakpoints | DAP controls already work; no C++ overload guidance | Document qualified signatures and source-line fallback |
| C++ globals and members | Extension resolves names/DWARF; raw local ELF inventory only has size hints | Document exact identities, namespaces, runtime-layout reads and diagnostic limits |
| Paused C++ locals, classes and STL | Native debugger implements scopes/objects; Agent Bridge has no inspection route | Add `debug.inspect` and `mcu-debug-control/scripts/inspect.js` |
| RTOS task stacks | Native adapter exposes task threads and frame-bound scopes | Reuse inspection with an explicit current DAP thread |
| FreeRTOS metadata | Decoder and sidebar exist; no Agent route | Add `rtos.status`, `rtos.snapshot` and bundled `mcu-rtos` |

The existing C++ debug control skill was partly compatible, but could not access the native
debugger's object presentation through its script. Documentation alone could not close that
gap. The added inspection service exposes only threads, stackTrace, scopes and variables;
it does not forward arbitrary DAP commands, evaluate expressions or add a new write path.

## Context and support boundaries

- Inspection requires a paused native EmberProbe session selected through the existing
  workspace/session/core routing. Paging is limited to 100 items per call.
- Frames and expandable variables use opaque handles scoped to the session, stop epoch
  and inspection epoch, with a 2048-handle budget. Writes, adapter invalidation and task
  lifecycle events invalidate inspection contexts; execution transitions and in-flight
  memory writes cannot yield a current inspection result.
- The RTOS skill reuses `RtosViewService` and the existing typed FreeRTOS decoder, including
  coalescing, partial results and stale-result checks. It does not acquire another probe.
- Structured snapshots are limited to the current single-core little-endian Cortex-M ARM32
  FreeRTOS decoder. OpenOCD awareness for another kernel is distinct from decoder support.
  TCB addresses/task keys are never treated as DAP thread IDs.
- Stack fill is an estimate, saved SP is not live SP, and runtime counters are not CPU
  percentages. A stopped snapshot cannot by itself prove starvation or deadlock.
- Concurrent C++ runtime-reader work in this workspace adds validated DWARF storage reads;
  the variable skill describes their range, race and budget limits separately from paused
  frame-local inspection. Existing RAM writes keep their confirmation and type checks.

## Validation

Passed: skill frontmatter validation, lint, formatting of this change, focused CLI/HTTP
Bridge regressions, RTOS view regressions, skill installation/contracts, bundle, and VS Code
Extension Host e2e. The e2e now checks Agent stack → scopes → vector expansion, paging and
invalidation after an actual DAP write. It uses subprocess MI fixtures without hardware.

Final `npm run check`: 309 files, zero failures. Earlier runs encountered ELF mock
incompatibilities while concurrent workspace changes were still being updated; the final
run passed. `quality` remains blocked by formatting in the other DWARF/runtime/memory-analysis
changes and three type errors in `src/memoryRegions.js`'s lookup callback. These are not
evidence of a passed quality gate. Independent coverage with workspace Temp passed all
142 tests and the coordinator/safety gates; the new inspection service and shared CLI have
100% line coverage. System Temp permissions required a workspace temporary
directory for e2e. No hardware acceptance, release, tag or publication was performed.
