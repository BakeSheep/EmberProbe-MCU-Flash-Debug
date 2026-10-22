# Large firmware degradation design: ELF size, DWARF budgets, large arrays

**Status:** design only. Nothing here is implemented. Base: local `master` at `eb18126`.

**Goal:** Remove three cliffs where a large but legitimate firmware currently loses a whole feature:

1. An ELF over 64 MiB is rejected outright.
2. Exceeding any global DWARF budget discards every type and layout.
3. An array with more than 65536 elements becomes unobservable.

**Principles**

- Keep memory bounded. The ELF Worker runs with `maxOldGenerationSizeMb: 512`. This design changes how a budget
  fails, not how large the budget is.
- On overflow, degrade the smallest unit that can be dropped: a section, then a compilation unit (CU), then an array
  window. Never degrade the whole ELF.
- Always report a degradation. Partial data must never look complete to the UI or to an Agent.
- Keep the write and identity rules from `AGENTS.md`. If type or address identity is uncertain, the value is
  read-only.

**Recommended order:** §2 Stage A first, then §1, then §3. §2 Stage B/C comes later. Shipping §1 alone only moves
the failure from `ELF_TOO_LARGE` to `DWARF_BUDGET_EXCEEDED`, which today also loses all types.

---

## 1. ELF file size cap (64 MiB)

### Current behaviour

- `ElfService.load()` rejects `stat.size > 64 MiB` before starting the Worker (`src/services/elfService.js:209`).
- The synchronous `read()` path does the same (`src/services/elfService.js:582`).
- The Worker repeats the check, then `readFileSync`s the whole file (`src/elfWorker.js:101-104`). It hashes the whole
  buffer and hands that buffer to `parseElfSymbols`, `parseElfSections` and `parseDwarfInternal`.
- Only a small part of the file is used:
  - The ELF header, section header table and `.shstrtab`.
  - `.symtab` and `.strtab`.
  - The seven `REQUIRED_DWARF_SECTIONS` (`src/dwarf/binary.js:8`): `.debug_info`, `.debug_abbrev`, `.debug_str`,
    `.debug_line_str`, `.debug_str_offsets`, `.debug_types`, `.debug_addr`.
  - `parseElfSections` uses section headers only, never section data.
- Never used: code and data, `.debug_line`, `.debug_frame`, `.debug_loclists`/`.debug_rnglists`, `.debug_aranges`,
  and `.debug_macro`. With `-g3`, `.debug_macro` is often the largest section.
- The 32 MiB decoded budget (`MAX_DWARF_SECTION_BYTES`) counts only *decompressed* sections. Uncompressed
  `.debug_info` is limited only indirectly, by the 64 MiB file cap.
- The ELF `sha256` is a security identity:
  - flash authorization (`src/flashAuthorization.js:29`, `src/services/agentFlashService.js:60`);
  - firmware-mismatch acknowledgement (`src/mainViewProvider.js:2841-2886`);
  - the runtime RAM cache and the CPU-load image key.

  It must stay a hash of the whole file.

### Design: load only the sections that are needed

1. **Sparse ELF reader.** Add a new module, e.g. `src/elfSparseReader.js`, built on an injectable `fs`.
   - Read the ELF header, the section header table and `.shstrtab` with positional reads (`fs.readSync` at an offset).
     Validate every offset and size against `stat.size`. Cap `shnum` and reject overlapping or out-of-file ranges, as
     `elfFormat` does today.
   - From those headers, compute the wanted ranges: `.symtab`, its linked `.strtab`, and the required debug sections.
2. **Single sequential pass.** Read the file once, front to back, in 1 MiB chunks.
   - Feed every chunk into `crypto.createHash("sha256")`.
   - Copy the bytes that fall inside a wanted range into that section's preallocated `Buffer`.

   The hash and the parsed bytes therefore come from the same read. `stat` before and after still detects changes
   (`ELF_READ_FAILED`).
3. **Parser API.** Return a `SparseElf { header, sections: [{name, type, flags, addr, offset, size}], data(name) }`.
   - `parseElfSymbols`, `parseElfSections` and `readSections` take this object. For tests, a full `Buffer` is wrapped
     in a trivial adapter.
   - `debugSectionData` stops slicing a whole-file buffer and receives the section's own buffer.
4. **Budgets.** Replace the file cap with budgets on the bytes actually loaded:
   - `MAX_ELF_FILE_BYTES`: a sanity ceiling, e.g. 2 GiB. It only guards against absurd inputs and costs I/O time, not
     memory.
   - `MAX_SYMBOL_TABLE_BYTES`: `.symtab` + `.strtab`, e.g. 64 MiB. The existing 16 MiB name-scan budget stays.
   - `MAX_DWARF_LOADED_BYTES`: one shared budget for required debug sections, counting raw bytes for uncompressed
     sections and decoded bytes for compressed ones. Proposed start: 96 MiB, to be calibrated by the benchmark below.
     It replaces the asymmetric 32 MiB decompressed-only budget.
5. **Degradation order.**
   - Symbol tables over budget: fail as today, but with a precise code, `ELF_SYMBOLS_TOO_LARGE`.
   - Debug sections over budget: publish symbols, then degrade DWARF. With §2 Stage A, keep the complete CUs that fit
     (`DWARF_PARTIAL`). Without it, emit `dwarfFailed` with `DWARF_BUDGET_EXCEEDED`.
   - Either way, the variable list stays usable.
6. **User-facing messages.** Replace the single `live.elfTooLarge` message ("64 MiB") with messages that name the
   exceeded budget and its size. Map the new codes in `src/webview/elfDiagnostics.js` and both i18n tables.
7. **Out of scope, but listed.** These readers keep their own caps for now:
   - `memoryAnalysisService` (64 MiB);
   - split-DWARF companions in `src/dwarf/files.js` (64 MiB total, 32 files);
   - `debugImages`.

   OpenOCD and GDB read the ELF themselves.

### Risks

- **Capacity:** The real limit becomes the DIE/heap budget (§2). A 300 MiB `-g3` ELF whose `.debug_info` is small loads
  fine. One with very large `.debug_info` degrades to partial types.
- **Hash cost:** Hashing large files on slow file systems (`\\wsl$`, network shares) can take seconds. The work runs in
  the Worker, so the UI stays responsive. Add a "hashing" progress status. Session reuse via
  `loadIdentity` (path/size/mtime) is unchanged.
- **Hash identity:** The hash must stay byte-identical to today's whole-file `sha256`, because flash authorization
  depends on it. Any mismatch would invalidate stored confirmations, or worse, accept a different file.
- **Untrusted headers:** Section headers come from the file. Overlapping ranges, wrap-around and sizes past EOF must
  be rejected before any allocation.
- **Two loaders to keep in sync:** The synchronous `read()` path in `ElfService` and the Worker path must share one
  loader.
- **Test fixtures:** Tests that fake `fs.readFileSync` (e.g. `test/elf-service.test.js:89-112`) need an injectable
  `openSync`/`readSync`/`fstatSync` fake.

### Test plan

- **Sparse loading:** Use a virtual fake `fs` that reports a 600 MiB file and generates bytes on the fly. Place a 500 MiB
  `.debug_macro` or `.text` region between the wanted sections. Assert:
  - only the wanted ranges are materialized;
  - peak `Buffer` allocation is within budget;
  - the result succeeds where today it raises `ELF_TOO_LARGE`.
- **Hash parity:**
  - For `buildElf32`/`buildDwarfElf` fixtures, the streamed `sha256` equals `crypto` over the full buffer.
  - The virtual-file case is compared against an independently streamed reference.
- **File changed during read:** The fake `fs` changes mtime or size between stats. Expect `ELF_READ_FAILED` and no
  published symbols.
- **Malformed headers:** Expect a coded error and no crash for:
  - a section past EOF;
  - offset + size overflow;
  - `shnum` far over the cap;
  - overlapping wanted ranges;
  - `shstrndx` out of range.
- **Budgets:**
  - Symbol tables over budget give `ELF_SYMBOLS_TOO_LARGE`.
  - Debug sections over budget give symbols published plus a DWARF diagnostic, with no throw from `load()`.
  - The file sanity ceiling still rejects before any read.
- **Regression:**
  - `elf-service`, `dwarf-*`, `dwarf-zstd-budget`, `elf-diagnostic-language`, flash-authorization and
    firmware-consistency tests stay green with unchanged `sha256` values;
  - `npm run check`, `npm run quality`, `npm run bundle`, `npm run test:e2e`.
- **Benchmark (opt-in, `test/perf/`):**
  - Load real large ELFs: a `-g3` build, a C++ build with TouchGFX/LVGL, and a compressed-section build.
  - Record wall time, Worker `heapUsed` (already reported in `dwarfReady`) and process RSS.
  - Use the results to set `MAX_DWARF_LOADED_BYTES` and record them in this file.

---

## 2. DWARF "all or nothing"

### Current behaviour

- **Global budgets in `parseDwarfInternal`:**
  - 2,000,000 DIEs across both passes (`src/dwarf/parser.js:143`);
  - 20,000 units;
  - abbreviations: 20,000 entries / 200,000 attributes;
  - decompressed sections: 32 MiB shared;
  - split-DWARF companions: 32 files / 64 MiB.
- **Budget errors are rethrown from every level**, on purpose: "全局预算耗尽必须中止整个解析"
  (`src/dwarf/parser.js:520-531`, `:573-574`).
- **Callers then drop all type information:**
  - The Worker posts `dwarfFailed` (`src/elfWorker.js:152`).
  - The in-process wrapper returns empty types and layouts (`src/dwarf.js:52-62`).
  - Symbols remain, but no variable has a type, layout or composite view.
- **Locals are skipped on the first pass.** A second pass (`retainLocals`) runs when a kept DIE references a skipped
  one. The DIE budget is shared across both passes.

### Design

#### Stage A: keep complete CUs

- **CU journal.** Each CU becomes the unit of rollback. Before parsing a CU, record a journal mark:
  - array lengths of `variableOffsets`, `subprogramOffsets`, `skippedOffsets` and `units`;
  - the keys this CU inserts into `dies`, `childrenMap`, `parentOf` and `signatures`. These are always inside
    `[sectionBase + cuStart, sectionBase + cuEnd)`, so the journal can be a list of inserted keys collected by
    `storeRecord` and the signature setter.
- **On a budget error inside CU *k*:**
  - Roll back CU *k*: truncate the arrays, delete the journaled keys, and roll back the abbreviation counters.
  - Stop scanning further CUs, sections and companions.
  - Record `partial = { reason, budget, parsedUnits, droppedUnits, droppedBytes }`.
  - Continue into the normal post-processing (origin inheritance, symbol binding, layouts) with what was kept.
- **Same rule for the other budgets:** units, abbreviations and the companion budget. The section budget is §1's
  unified budget: a section that does not fit is not loaded, which is the same as "no CUs from it".
- **Retry pass.** If pass 1 (`retainLocals`) hits the budget, stop pass 1 in the same way. Its kept CUs replace those
  of pass 0. Pass 0's result is not kept separately, so memory does not double.
- **Diagnostic.** Add one `DWARF_PARTIAL` diagnostic with the counts. Set `result.typeMetadataIncomplete = true`, which
  already exists. Add an i18n line such as "Types loaded for 812 / 1,240 compilation units (DIE budget)" and map it
  in `elfDiagnostics.js`.
- **Symbols whose defining CU was dropped:**
  - Keep the existing size-based raw view.
  - Never guess a layout.
  - Writes stay refused because `staticRuntimeWriteLeaf` and the write gates already need a verified layout.
  - Agents see `typeMetadataIncomplete`.
- **Cross-CU references into a dropped CU** resolve as missing. `_buildCompositeLayout` already returns `null` or
  `limited(...)` for an absent `typeDie`. This covers `DW_FORM_ref_addr` (LTO), `abstract_origin`, `specification`
  and type-unit signatures.

#### Stage A implementation notes (implemented)

- A single pass-level `catch` in `parseDwarfInternal` turns every `DWARF_BUDGET_EXCEEDED` raised while scanning
  units or loading companions into "roll back the current unit, stop". The budgets this covers are DIEs, units,
  abbreviations/attributes, the diagnostic cap, companion bytes, and the section budget for companions.
- The main ELF's section decompression budget is still checked before any unit is scanned, so it still fails the
  whole parse. That moves to §1's unified loaded-bytes budget.
- `options.budgets` accepts `dies`, `units`, `abbrevs`, `attrs`, `sectionBytes` and `companionBytes`. Values can only
  lower the production limit (`DEFAULT_BUDGETS`). `parseDwarf` never caches a budgeted parse.
- `DWARF_PARTIAL` is the first diagnostic. It carries:
  - `i18nKey: "elfDiag.partial"`;
  - `{ loaded, total, budget }`;
  - `loadedUnits`/`droppedUnits`/`droppedBytes`, also returned as `parsed.partial`.

  Dropped units are counted from unit headers only.
- **Deviation from this design:** symbols whose unit was dropped are not shown with a size-based raw view. With
  `typeMetadataIncomplete`, `ElfService._enrich` already lists them as "no DWARF type info", not watchable and not
  writable. This existing, stricter behaviour is kept.
- **Fix found during implementation:** `classifyVariableOrigin` treated "no DWARF record" as "toolchain runtime"
  once DWARF was complete. A partial parse now passes `debugComplete: false`, so dropped user variables are not
  hidden by the origin filter.
- **Not covered by tests:** signature rollback (`.debug_types` / DWARF 5 type units). The journal handles it, but no
  test exercises it.

#### Stage B: keep the CUs the user cares about

- **Pre-scan, CPU only.** Walk each CU's DIEs with abbreviation-driven attribute skipping and store nothing per DIE.
  For each CU, record:
  - offset range and DIE count;
  - the addresses of variables it defines (`DW_TAG_variable` with `DW_OP_addr` locations);
  - the type-unit signatures it references.

  Memory is O(#CU + #globals). Time is roughly one extra decode of `.debug_info`, so add a parse time budget (none
  exists today).
- **Priority hints.** The host passes hint addresses to the Worker at load: every symbol in the sidebar, chart and
  write lists. Materialize CUs in this order, until the budget is spent:
  1. CUs that define hinted addresses;
  2. type units referenced by those CUs;
  3. CUs referenced through `ref_addr` from (1), one level deep;
  4. all remaining CUs in file order.
- **Reload on demand.** If the user adds a type-less variable from a partial ELF, the host reloads with that address
  added to the hints. Reload is already cheap with §1 and the session cache.

#### Stage C (optional, later): on-demand CU materialization in a running Worker

- Use LRU eviction of whole CUs.
- Deferred because eviction must invalidate cached layouts, `layoutExpansions` handles and the runtime type graph that
  reference evicted DIEs. That is a large new consistency surface for a small gain over Stage B's reload.

### Risks

- **Rollback completeness:** The journal must catch every structure that records a CU's DIEs. A missed one leaves
  dangling relationships, which can produce *wrong* layouts, not just missing ones. Mitigation: journal only inside
  `storeRecord` and the few push sites, plus the equivalence test below.
- **Silent partial data:** Partial results must be visible in the UI, in diagnostics and in Agent responses. Agent
  skills should treat `typeMetadataIncomplete` as "do not infer layout".
- **Determinism:** The kept CU set depends on budget and hints. Two machines, or two hint sets, can show different
  types for the same ELF. Cache keys that include `sha256` (runtime RAM cache, layout cache) must also include the hint
  set, or partial results must not be cached across hint changes.
- **C++ type units / LTO:** If type units fall outside the kept set, many classes become opaque even though their
  variable CUs were kept. Stage B's priority order addresses this. Stage A alone may look worse than expected on LTO
  builds.
- **Retry interaction:** Pass 1 can now end partial where it used to throw. Make sure a partial pass 1 is not reported
  as "all locals retained".
- **CPU time:** Stage B's pre-scan roughly doubles `.debug_info` decode time. Needs the new time budget and a
  progress status.
- **Existing assertions change:** `test/dwarf-global-budget.test.js:61,90` asserts a throw today.

### Test plan

- **Budget injection.** Add a test-only `options.budgets` override to `parseDwarfInternal`, so tests can use small
  limits instead of millions of DIEs. Production limits stay constants.
- **Synthetic multi-CU ELF** (`buildDwarfElf`): N CUs, each with a global and a struct type, DIE budget set to fit *k*
  CUs. Assert:
  - no throw;
  - CUs 1..k have full types and layouts;
  - later CUs have none;
  - exactly one `DWARF_PARTIAL` with correct counts;
  - `typeMetadataIncomplete === true`.
- **Rollback equivalence.** Parse the same ELF fully and partially. For every kept symbol, compare `buildVariableTypes`,
  layouts and runtime layouts deeply. For dropped symbols, assert absence, not a fallback guess.
- **Cross-CU reference.** A `ref_addr` from a kept CU into a dropped CU yields an unobservable or null member, never a
  different type.
- **Each budget kind:** units, abbreviations/attributes, companion count/bytes, unified section bytes, and pass-1
  overflow.
- **Priority (Stage B):** a hint address defined in the last CU is kept while earlier CUs are dropped; a type unit
  referenced by a hinted CU is kept.
- **Host and Agent:**
  - `elf-service` publishes symbols + partial diagnostic;
  - the variable plan for a dropped symbol reports metadata-incomplete and refuses writes;
  - the webview shows the partial notice (`elf-diagnostic-language`, webview tests).
- **Regression:** all `dwarf-*` tests, `cpp-*` tests and the GDB-toolchain suites in `test/gdb/` (parser changes);
  `npm run check`, `npm run quality`.
- **Benchmark:** On a real ELF that exceeds 2M DIEs, record time and heap for: full failure today, Stage A, and
  Stage B with hints.

---

## 3. Arrays with more than 65536 elements

### Current behaviour: four independent caps

- **Layout build:** `totalElements > 65536` gives `limited(..., "expansion-budget")` (`src/dwarf/types.js:599`). The
  whole array becomes unobservable, even though the layout stores the element type once and costs O(dims), not
  O(elements).
- **Validation:** `validateComposite` limits the leaf-equivalent count (`count × multiplier`) to 65536
  (`src/compositeValidation.js:6-38`). So `float buf[70000]`, or `struct {int a,b;} s[40000]`, is invalid even below the
  layout cap.
- **Traversal:** `expandCompositeLeaves` and `decodeComposite` visit every element of every sample, limited by
  `MAX_LAYOUT_VISITS` = 65536 (`src/webview/runtime.js:12`, `src/elfSymbols.js:927,1029,1090`).
- **Read plan and history:**
  - `buildActiveReadPlan` reads the entire composite (`src/services/liveWatchService.js:88-99`).
  - `buildChartHistoryItems` expands every leaf into history series (`:127-141`).
- **Partial windowing already exists, but only in the UI:**
  - The live-watch panel has an array range dialog (`showArraySelectDialog`, `disp.start/end`, ≤256 shown,
    `src/webview/liveWatch/renderer.js:718,1371-1375`).
  - The sidebar shows the first 16 elements (`src/webview/sidebar/renderer.js:1829`).
  - Member paths already parse `index`/`range`/`all` segments.
  - The C++ runtime reader caps arrays at 100 elements with `partial: true`.

### Design: an "array window" model shared by layout, read plan, decode and UI

1. **Layout.** Replace the 65536-element cap:
   - Keep a sanity cap: `totalElements ≤ 2^24`, `count × width ≤ available` bytes, as already validated.
   - Mark arrays above `WINDOW_THRESHOLD` (e.g., 256 leaves) as `windowed: true` when the layout is annotated.
     Annotation only, so the type-layout cache is unchanged.
2. **Window spec.** A window is `{ path, start, end }` on the outermost dimension of a windowed array.
   - **Default window:** `[0, min(total, 16))`, matching the sidebar today.
   - **Live-watch window:** the existing `disp` range, max 256 elements.
   - **Agent window:** at most 4096 elements and 64 KiB per request.
   - **Multi-dimensional and struct arrays:** size the window by leaves, not rows. Rows =
     `max(1, floor(256 / leavesPerRow))`. For example, `uint8_t img[480][640]` shows whole rows.
3. **Validation.** Change `validateComposite` to charge only the default window of each windowed array against the
   65536-leaf budget. Byte-bounds checks still cover the full `count × width`.
   - Any consumer that enumerates must pass explicit windows. A consumer that passes none on a windowed layout gets the
     default window, never the full array.
4. **Decode.** `decodeComposite(bytes, layout, symbol, { windows })` emits only the window's elements. The array node
   carries `totalElements`, `windowStart`, `windowEnd` and `partial: true`, the same shape the runtime reader already
   uses.
5. **Read plan.**
   - A fixed composite that contains windowed arrays is read as sub-ranges: the struct bytes outside any windowed
     array, plus each window's byte slice.
   - Today's single `{name, address, size}` item becomes `{ name, address, size, readRanges }`.
   - `compileReadBatches` and the DAP paused reader (`mergeReadPlan`) read the ranges.
   - The sample carries a sparse buffer (full-size `Uint8Array` + coverage ranges).
   - The decoder treats bytes outside coverage as unavailable. This also covers audit item P1#4 ("read what is shown")
     for large arrays.
6. **Consumer merge.** `buildActiveReadPlan` merges the windows that different consumers (sidebar, each chart panel,
   write list) request for the same variable. It takes their union, with a cap on the merged byte count. Debug-mode
   per-cycle limits use the per-item partition from the P0 fix: an over-budget window is rejected on its own.
7. **Chart history.** `buildChartHistoryItems` expands leaves only inside windows, capped at e.g. 256 leaves per
   composite, with a diagnostic when truncated.
8. **UI.**
   - Give the sidebar the same paging control the live-watch dialog has: `[0..15] of 131072`, previous/next, jump to
     index.
   - Persist the window per watch item, next to the existing `disp`.
9. **C++ runtime reader (later stage).** Accept the same window spec instead of the fixed first 100 elements.

### Risks

- **Sparse samples:** Consumers that slice `parent.bytes` by offset must check coverage first. Examples:
  `decodeHistorySamples` (`src/services/liveWatchService.js:257-272`), pointer annotation and write-card sync.
- **Window state:** Windows are per consumer and persistent. Stale windows after an ELF change (array shrank) must be
  clamped or reset, never read out of bounds. `resolveLayoutPath` already rejects out-of-range indices.
- **Validation semantics:** Relaxing `validateComposite` could admit layouts that an unaware consumer then walks in
  full. Mitigation:
  - Enforce the default window inside `expandCompositeLeaves` and `decodeComposite` themselves, not in callers.
  - Keep `MAX_LAYOUT_VISITS` as a backstop.
- **Writes:** Element writes inside a windowed array go through the normal per-leaf address path. Verify that write
  verification reads only that element, not the window.
- **Tearing:** Range reads of a window are not atomic across Tcl commands while running, same as today. Paused reads
  stay consistent.
- **Multi-dimensional row windows:** Edge cases where a single row exceeds the window budget (e.g., `[2][100000]`)
  need a nested inner window or a "row too large" note. Inner-dimension windows are out of scope for the first stage.

### Test plan

- **DWARF:**
  - `uint8_t a[131072]`, `struct {int a,b;} s[100000]` and `uint16_t img[480][640]` produce observable layouts with
    `windowed: true` and the correct `totalElements`;
  - `2^24 + 1` elements is still `expansion-budget`;
  - `test/dwarf-composite.test.js:835-839` bound expectations are updated.
- **Validation:**
  - windowed layouts pass;
  - a byte-size overflow still fails;
  - nested struct arrays and multi-dimensional arrays are charged by window leaves.
- **Decode:**
  - only window elements are produced;
  - `partial`/`windowStart`/`windowEnd` are correct;
  - bytes outside coverage decode as unavailable;
  - a call without windows gets the default window.
- **Read plan:**
  - prefix/suffix/window ranges are computed;
  - the union of two consumers' windows is correct;
  - the merged-byte cap holds;
  - in debug mode, an oversized window is rejected on its own (reuse `partitionManagedReadPlan`).
- **Transport:**
  - With `FakeOpenOcdServer`, Tcl commands touch only window addresses and the sparse result is reassembled.
  - DAP paused reads read only the ranges.
- **History:** leaves are limited to windows and the 256-leaf cap emits its diagnostic.
- **Agent:**
  - `buf[70000:70010]` returns 10 elements;
  - out-of-range and over-limit requests return coded errors.
- **Webview** (render-webview helpers): the sidebar paging control renders, changes the window, persists it, and clamps
  after an ELF change.
- **Regression and benchmark:**
  - `composite-decode`, `layout-expansion-*`, `live-read-batch-cache`, `live-watch-*`, `chart-*` tests;
  - `npm run check`, `npm run quality`, `npm run bundle`, `npm run test:e2e`;
  - opt-in benchmark: per-tick decode and read time for a 1M-element array with a 256-element window.
- **HIL (opt-in, with approval):** on H750, sample a window in a ≥128 KiB RAM buffer standalone and in debug mode.

---

## Open questions

- **Budget calibration:** `MAX_DWARF_LOADED_BYTES`, the parse time budget and `WINDOW_THRESHOLD` should be set from
  benchmarks on real large firmware. Which ELFs should serve as reference?
- **User settings:** Should these budgets be settings? Recommendation: no for memory-safety budgets. At most, an
  expert setting for the file sanity ceiling.
- **Stage B hints:** Should hints include Agent-requested symbols from the current session, or only persisted watch
  lists?
