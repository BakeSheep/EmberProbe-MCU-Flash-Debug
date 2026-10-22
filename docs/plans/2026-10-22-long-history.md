# Whole-session chart history implementation plan

**Goal:** View the entire current sampling generation while retaining bounded recent memory and a separate archive index.

**Architecture:** Keep ChartHistoryStore as the synchronous recent-data implementation. Add a Worker-owned read-only
archive index and an asynchronous store wrapper. Use hierarchical typed-array summaries for wide views and bounded,
cached raw reads for narrow views. Capture archive byte/time cuts in snapshots and invalidate pending reads on lifecycle
changes. The host reports durable archive progress independently of memory append backpressure.

**Tech stack:** CommonJS ES2022, Node filesystem promises, Worker threads, existing EPSA decoder and chart transport.

1. Add incremental index, hierarchy, accounting, raw range cache and focused synthetic archive tests.
2. Add asynchronous archive/memory viewport composition, whole-session status and snapshot/lifecycle guards.
3. Wire SamplingArchive durable-write hooks and host progress, configure, clear and restart paths.
4. Register and run index, Worker, high-rate, snapshot, concurrency and whole-session webview regressions.
5. Add and run the opt-in 1/10-channel, 200 Hz, 2/8-hour benchmark; record measurements here.
6. Update layered/unlimited sampling documentation; run check and quality against the 440-file passing baseline.

No commits, branches, README/CHANGELOG edits, bundle, E2E, HIL, packaging, network or manual generated-output edits.

## Implemented paths

- New `src/services/archiveHistoryIndex.js`: incremental complete-record decode in 1 MiB chunks (larger for a record
  straddling the chunk), independent dictionaries, growable typed pages, 256 × 16^level summaries, byte ranges and
  bounded decoded raw-range LRU. Index accounting includes typed capacity, text, dictionaries, series and snapshot tails.
  The budget drops oldest L0 pages first and can continue at higher levels for extremely long sessions.
  Invisible cleared generations are reclaimed under pressure before dropping current-generation detail; snapshots pin
  their generation until release.
  Under a tight budget, even partial lower-level tails can be dropped; their parents keep receiving samples, and the
  fine level resumes at its next page boundary. This avoids a large per-channel tail allocation floor.
- New `src/services/archiveChartHistoryStore.js`: Worker-side asynchronous archive viewport, shared column reduction,
  recent continuous memory seam, identity/generation/start filtering, full-session status, snapshot byte/time cuts and
  immutable partial summary tails. Recent memory views bypass a queued re-index; disk reads recheck lifecycle state.
  Late rounds are reduced as separate chronological runs; closing a consumer releases memory without inventing a new
  archive generation.
- `src/chartHistoryWorker.js`: async viewport/freeze/progress dispatch and lifecycle operations; packed transport remains.
- `src/services/samplingArchive.js`: `onWritten(bytes)` runs after a completely written/indexed drain.
- `src/services/chartHistoryService.js`: coalesces durable progress to 250 ms, retains the latest source across restart,
  and immediately synchronizes a newly started Worker. Clear also forces a synchronization.
- `src/mainViewProvider.js`: passes archive generations and progress, reports archive failure/full separately from memory
  pressure. Append/backpressure acknowledgements and host warning paths respect archive coverage rather than warning
  unconditionally for memory gaps. Recovery marks viewed channels with `touchViewport` without waiting for a complete
  archive re-index; the
  existing 30-second recent-memory restore timeout remains independent of whole-file indexing.
- New `test/archive-history.test.js` and registration in `scripts/test-groups.js`; new opt-in
  `test/perf/long-history-bench.js`. Renderer code needs no change: All, timeline, overscan and overview already use status
  bounds. Its 30-minute constants apply to the non-backend fallback.
- `docs/LAYERED-SAMPLING.md`, `docs/UNLIMITED-SAMPLING.md` and this implementation record describe the new roles.

Snapshots copy only mutable summary tails for their own scope/generation, with those copies charged to index bytes.
Completed summary buckets remain shared; if a lower page is later dropped, the retained parent supplies a coarser view.
Missing coarse buckets conservatively isolate representatives; zooming to raw rows recovers exact gap positions when
the raw byte budget and retained L0 permit it. Dropping L0 itself is not a viewing limit.

## Software benchmark — before (P2b)

Command: `node test/perf/long-history-bench.js`. Windows 11, Node v24.13.1, synthetic 200 Hz, fresh Worker per case,
EPSA encoder records written directly to a temporary file. Each query requests all channels at 1200 columns.
The resumed-task run measured these cases separately from full check/coverage jobs. These are single-run wall-clock
observations, not steady-state latency guarantees. RSS is process RSS while the Worker is active (Node threads share
a process).

| Channels | Hours | Archive MiB | Index build MB/s | Index MiB | Full ms | Old 10 s ms | Old 10 min ms | RSS MiB |
| -------: | ----: | ----------: | ---------------: | --------: | ------: | ----------: | ------------: | ------: |
|        1 |     2 |       38.45 |            18.66 |     0.827 |    9.97 |        4.59 |        107.05 |   347.6 |
|        1 |     8 |      153.81 |            18.53 |     3.302 |    4.85 |        5.11 |         98.39 |   363.0 |
|       10 |     2 |      124.97 |             8.14 |     8.270 |   78.76 |       23.37 |        558.54 |   353.4 |
|       10 |     8 |      499.88 |             7.39 |    33.019 |   23.45 |       17.91 |        628.62 |   397.1 |

Full-range queries read zero raw bytes. Buckets touched per channel: 6002 at 2 h and 1502 at 8 h (the latter selects a
higher summary level). Old 10-second requests read 0.062 / 0.200 MiB for 1 / 10 channels and reuse decoded ranges across
channels. Old 10-minute requests read 3.213 / 15.996 MiB: at 1200 columns a column is only 0.5 s, smaller than a 256-point
bucket at 200 Hz, so they use raw rows. The 10-channel case reaches the shared 16 MiB request cap and falls back to L0
for the rest. Cache bytes after these queries: 0.541 / 2.881 MiB.

Whole-file re-indexing took 2.2 / 8.7 / 16.1 / 70.9 s in this run. Recent-memory restore and recent viewports proceed
while it runs; a request requiring still-unindexed old data waits for the queued tail. This startup cost is a known
tradeoff of rebuilding an in-memory index rather than maintaining a second persistent index file.

## Validation

Baseline `npm run check`: `440 files checked; 0 failed`.
An intermediate full check/quality run exposed two host test fixtures without an archive generation Map:
`TypeError: Cannot read properties of undefined (reading 'get')` in `chart-host.test.js` and `composite-history.test.js`.
These were introduced by this change and fixed by accepting generation-less archive test doubles as generation zero;
both focused suites pass afterward. No baseline test failed.

Focused archive tests cover arbitrary byte cuts, restart, scopes/generations/identity/start filters, raw reduction against
the original store, exact u64, gaps, neighbours, seams, memory caps, index compaction, raw cap/LRU, concurrent reads,
clear/configure/remove/release cancellation, immutable freeze cuts including equal-time later writes, actual Worker
restart/progress throttling, randomized raw-grid equivalence, late/disordered rounds, missing boundary neighbours,
and full-session All/timeline/overview bounds (slider maximum/value, end label and fill) in JSDOM.

Final `npm run check`: `443 files checked; 0 failed` (baseline 440, plus two new source modules and one normal test).
Final `npm run quality`: ESLint, repository-wide Prettier checks, JavaScript type checking, `218 files checked; 0 failed`,
global coverage and coordinator/safety module gates all passed. Coverage: 87.20% lines/statements, 85.87% branches,
91.03% functions. New-module line coverage: archive store 93.05%, archive index 97.87%. `git diff --check` passed.
No pre-existing or outstanding failures remain. Existing user/P0/P1/P2a changes were extended without staging,
reverting, or formatting pre-modified files. The renderer/value-panel/layout and release work were not edited by P2b.

Bundle is explicitly skipped because it cannot run in this sandbox. No E2E, hardware, external network, packaging or
publishing was performed; real Webview interaction remains unverified. Software/JSDOM tests do not establish hardware
support or native Canvas timing. Older history can be coarser after index/raw-budget fallback; re-index latency is
reported above. No remaining implementation item is deliberately deferred.

## P2c: indexing and viewport performance

The original P2b numbers and validation record above are retained as the before record. P2c changes only the archive
format reader, archive index/store, their two focused test files, this document, and the opt-in benchmark. No Worker
protocol or host/webview change is needed.

Implementation steps completed:

1. Add `scanRecords`, retaining `decodeRecords` and `readArchive` for existing callers. It validates the complete row
   before invoking callbacks, validates UTF-8 and dictionary references, and stops at the same complete/valid boundary
   as `decodeRecords`. Numeric rows allocate no row/value objects or numeric strings. Optional last-key selection
   handles repeated values and differing identities without changing decoder semantics.
2. Resolve index series through numeric scope/generation/channel Maps. Create the external string key once per series;
   charge lookup metadata to the series allowance, including additional dictionary aliases. Empty rows create no
   lookup state, and generation compaction removes all aliases.
3. Update the active bucket directly in its Float64 page. Cascade completed children to their parents once per child;
   publish partial parents at each durable chunk boundary. Partial merges preserve sample ordinals, earliest equal
   extrema, exact text, missing/disorder flags and byte/time bounds. If a fine page was dropped, its retained parent
   receives samples directly until the fine level resumes. Snapshot tails remain copied and charged.
4. Cache bounded wire ranges and validated row offsets in the existing LRU. Concurrent reads of the same range share
   one pending read. The scanner's validation-only sink also verifies a reusable entry layout when every row has the
   same channel IDs, positions and record size. Equal-width numeric kind changes can share this layout; changing IDs,
   positions, counts or sizes disables it. Subsequent series decode only the requested key/identity and payload;
   interleaved values are skipped. Wire buffers, offset/layout capacity and cache metadata are charged. Tiny cached
   ranges use unpooled buffers so they cannot pin an unaccounted shared slab. The shared 16 MiB raw request cap and
   8 MiB LRU cap remain unchanged; there is no whole-file buffer.
5. Read summary fields directly from pages and reduce monotone, gap-free, single-identity history into four candidates
   per column. Avoid per-bucket sorting/filtering and the second reduction for archive-only results. Keep the general
   merge path for mixed identities, gaps and disorder; preserve weights when joining a memory suffix. Deferred summary
   fields are copied before awaiting raw reads, so a concurrent append cannot mutate a planned result.
   The store explicitly opts into column reduction; direct index queries keep their point-array return contract, and
   unfiltered raw reads keep their decoded-row contract.

The benchmark now reports `workerHeapUsedMiB` and `workerArrayBuffersMiB` from `process.memoryUsage()` inside the benchmark
Worker after its three queries. These are Worker-local measures; `workerRssMiB` remains process-wide and includes the
benchmark's main-thread archive generation. Measurements use no forced GC or query warmup.

### P2c validation

The task baseline was `npm run check`: `443 files checked; 0 failed`. Existing assertions remain unchanged. Added tests
compare scanner output/dictionaries/boundaries against `decodeRecords` for every wire kind, arbitrary cuts, mutated
records, invalid headers/definitions/UTF-8/references, dictionary snapshots, duplicate keys and skipped visitors. They
also check callback errors propagate without being mistaken for corrupt input.
The row-offset sink is checked against the callback scanner on the same malformed/truncated fixtures. Fixed-layout
tests cover int/f32 transitions, layout invalidation, final duplicate identities and backing-buffer accounting.

New archive tests compare every level's first/min/max/last, row counts and byte bounds with independently decoded rows
across complete and partial cascades. They cover raw-grid equivalence for three numeric/exact series, equal timestamps,
coarse numeric snapshots, memory-seam weights, duplicate channel IDs/keys, numeric lookup reclamation and a fixed P2b
mixed-identity/gap result. A separate temporary differential harness compared 480 mixed-identity and 480 single-identity
viewports against saved P2b modules: all 960 match, including clean/gapped/disordered input and raw-budget fallback.

Development failures were resolved before final validation:

- `SyntaxError: Identifier 'first' has already been declared`: introduced while replacing the reducer; renamed its
  viewport boundary indices.
- `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` in a new equal-timestamp seam fixture,
  including `visibleCount: 29` versus `30`. The exact failure also reproduced against the saved P2b implementation:
  starting a memory suffix between two equal-timestamp archive rows excludes the earlier row at that seam. Aligned the
  fixture with the start of the equal-time group; that existing seam behavior is unchanged.
- `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` in the mixed-identity differential
  audit (`actualPoints: 65`, `expectedPoints: 83`). Introduced by reducing a clean identity before merging the other
  identity's gaps. Restricted direct reduction to one archive identity and added the fixed-result regression above.
- Prettier reported `Code style issues found in 4 files. Run Prettier with --write to fix.` during development. Applied
  formatting patches only to P2c edits; never ran `prettier --write` on a pre-existing modified file.
  A later added assertion also reported `Code style issues found in the above file. Run Prettier with --write to fix.`;
  its formatting was corrected before the final quality run.

No baseline failure was observed. The equal-time partial seam limitation above is pre-existing, reproduced separately,
and outside this behavior-preserving performance task. Bundle, E2E, packaging, HIL and network remain explicitly skipped
as requested. No commits, branches, staging, stashing, README/CHANGELOG edits or unrelated file edits were performed.

### P2c benchmark — after

Reviewer run of `node test/perf/long-history-bench.js` on the final tree (same machine and settings as the "before"
table; single run, no warmup). Heap is Worker-local `heapUsed` after the three queries.

| Channels | Hours | Index build MB/s | Build ms | Index MiB | Worker heap MiB | Full ms | Old 10 s ms | Old 10 min ms |
| -------: | ----: | ---------------: | -------: | --------: | --------------: | ------: | ----------: | ------------: |
|        1 |     2 |            257.8 |      156 |     0.827 |            10.8 |    3.67 |        3.96 |         29.83 |
|        1 |     8 |            290.9 |      554 |     3.302 |            10.4 |    2.82 |        3.39 |         20.47 |
|       10 |     2 |            162.1 |      809 |     8.270 |            13.5 |   16.98 |        8.30 |         59.11 |
|       10 |     8 |            168.1 |     3118 |    33.019 |            14.0 |    8.83 |        7.74 |         62.34 |

Against P2b: indexing is 14–39× faster (10 ch × 8 h re-index 70.9 s → 3.1 s), old 10-minute views 3.6–10× faster
(629 → 62 ms for 10 ch), and full-range views 1.7–4.6× faster. All targets in the P2c task are met. Final reviewer
validation: `npm run check` 443 files 0 failed, `npm run quality` passed, `npm run bundle` passed.
