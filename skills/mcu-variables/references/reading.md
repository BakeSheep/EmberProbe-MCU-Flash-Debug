# Reading, trending, and exporting variables

Use `scripts/read.js` from the Skill directory.

## Shared sampling controls

Use these commands when asked to start, stop, or inspect persistent sidebar/chart sampling:

```bash
node <skill-dir>/scripts/sampling.js --workspace <workspace> --status
node <skill-dir>/scripts/sampling.js --workspace <workspace> --start --interval 100
node <skill-dir>/scripts/sampling.js --workspace <workspace> --stop
```

`--interval` is optional, in milliseconds (20–10000); omission preserves the current interval. Start uses the union of enabled sidebar and chart watches. To add requested variables first, use `read.js --add-to sidebar` below. An empty watch list enables sampling intent but collects no data until variables are added.

This is the same shared state as the user's controls: the sidebar and open charts update immediately, and sampling continues after the CLI exits. `running`/`intentEnabled` describe the shared switch; inspect `starting`, `canRead`, and `mode` before claiming that acquisition is active. Query status again after pending startup or debug transitions. Stop also cancels a temporary Agent read, but does not terminate debugging or clear watch lists/history. Do not use `debug.js --stop` to stop sampling.

For a finite trend or one-time read, use the commands below; they do not require persistent sampling to be started.

## Reads and trends

For a current value, pass names directly. Do not search source declarations first, require pre-started sampling, or add type suffixes unless the user requests reinterpretation:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables Tick,sinx
```

Results include `firmwareConsistency`: `match` when the configured ELF has the SHA-256 that EmberProbe last programmed in this workspace, `mismatch` when it differs (for example a rebuild that was not flashed), and `unknown` when EmberProbe has no record. On `mismatch` the result also carries an `ELF_TARGET_MISMATCH` warning: addresses come from the disk ELF and may not match the running firmware, so report the warning with the values and suggest flashing the current ELF; do not present the values as reliable. `unknown` is not an error, because programming by other tools is not observed.

Use `--list` only after a missing or ambiguous name. By default `--list` prints NDJSON (one JSON object per line, not a single JSON document), so `JSON.parse(stdout)` fails; parse it line by line. Every line repeats the ELF binding `elf`, `elfSha256` and `elfMtimeMs` and adds one symbol's fields (`name`, `address`, `size` and others from the ELF symbol table) plus `inferredType` and `compositeCandidate` (`true` when the symbol is larger than 8 bytes). For a single JSON document, add `--json-array`: `node <skill-dir>/scripts/read.js --workspace <workspace> --list --json-array` prints one object `{ "elf", "elfSha256", "elfMtimeMs", "symbols": [ { ...symbol, "inferredType", "compositeCandidate" } ] }` with the binding fields once. `--json-array` is valid only with `--list`; the default NDJSON output is unchanged. DWARF paths support members and array selections such as `sensor.pos.y`, `buf[0]`, `buf[1:5]`, and `buf[*]`. Whole composites return a reporting tree and cannot be trended.

C++ names can contain `::`; quote qualified paths such as `"app::sensor.pos.y"`. Prefer an
exact ELF/linkage name when a display name is ambiguous. Explicit scalar suffixes use a
single colon (`"app::counter:u32"`). Missing or ambiguous C++ DWARF types must remain
unavailable; do not guess a scalar encoding from object size. `--list` is a local raw ELF
symbol inventory (names may be mangled and `inferredType` is only a size hint), not DWARF
type validation. Avoid legacy `--elf`/`--port` direct Tcl reads for C++ objects because they
bypass extension type binding.

The current runtime reader also resolves supported libstdc++ storage, references, typed
pointer/member paths and supported virtual/dynamic layouts from the selected ELF's DWARF.
For example, request `"app::values[1]"` or `"owner->nested->value"`; storage addresses are
resolved anew on each sample. Reads require verified memory ranges and are bounded to
4096 bytes, 32 reads and a time budget per cycle, with bounded depth/nodes. Container trees
may be partial, and whole objects cannot be scalar trends; request a supported scalar leaf.
`LIVE_OBJECT_CHANGED` means a descriptor changed during the read, so that sample is invalid;
`LIVE_ADDRESS_NOT_RAM`, `LIVE_LAYOUT_UNSUPPORTED`, null/cycle and budget diagnostics must
remain unavailable, not be bypassed with an explicit scalar suffix or direct Tcl read.
Raw pointers outside STL are followed only through an explicit `.value` or `->` segment,
one level per request, never into `void`, function or declaration-only targets; such targets
are read-only. Pointer leaves report `isPointer`, `pointerTarget`, a hexadecimal `valueText`
and, when the ELF symbols resolve it, `pointerText` such as `→ &rxBuf[12]` with a structured
`pointerInfo`; `char *` into read-only ELF data may add `pointerString` such as `"hello"`. Report
the address and annotation instead of the decimal value. Composite results keep every raw member;
`memberRole: "artificial" | "internal"` marks compiler and standard-library internals that the
EmberProbe UI hides by default. See `docs/POINTER-DISPLAY.md` in the extension repository.
Running multi-read observations are not atomic snapshots. For task-local variables or
GDB's paused object presentation and paging, read
[../../mcu-debug-control/references/paused-inspection.md](../../mcu-debug-control/references/paused-inspection.md).

For trends, use `--trend`; it defaults to ten samples. EmberProbe reuses an existing compatible connection or owns and releases a temporary sampling session:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables counter --trend --interval 200
```

Use `--add-to sidebar|chart|both` only when the user asks to update the EmberProbe UI. Adding does not start sampling. Watches are saved under raw ELF names, so `added` and `alreadyPresent` list those names: a request for the display name `ep7` reports `_ZL3ep7`, and `ep7.port` reports `_ZL3ep7.port`. When a request matched a display name, `resolvedNames` maps it to the raw name (`{"ep7": "_ZL3ep7"}`); the UI still shows the display name. Export an open chart's real history with `--export-csv`; prefer `--last <seconds>` or complete ISO 8601 UTC timestamps, and keep `--output` relative to the workspace:

Agent CSV reads the chart's full sampling archive. Column headers include the decoded type so history remains clear if a watch's type changes. Results larger than 64 MiB are rejected explicitly; use the chart's archive export dialog for larger files. `historyTruncated: true` means the archive hit its size cap and stopped recording while the chart kept drawing, so the CSV covers less than the requested range: compare `from`/`to` with what was asked and report the gap instead of presenting the rows as complete.

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --export-csv --variables counter,temperature --last 30 --output exports/live.csv
```

If an EmberProbe-managed debug target is running, reads are limited to writable allocated ELF RAM. A paused session may use DAP memory. Never pause a user-managed session implicitly. Report resolved names, inferred types, exact text values where present, source, and concise trend or composite results.

On failure, use the diagnostic's `error.code`, `likelyCause`, `suggestedActions`, and `details`. Distinguish probe absence, target connection or power, probe ownership, Tcl port, configuration/ELF, and Bridge errors.

A batch with some unresolvable variables still succeeds for the others. The output then has
`partial: true` and `variableErrors`, one entry per failed request with `requestedName` plus the
same `code`, `category`, `likelyCause`, `suggestedActions`, and `details` fields as a full
diagnostic (for `--count`, a separate `type: "variableErrors"` line comes before the samples).
Report the returned values, and fix or explain only the listed names instead of retrying the
whole batch. The command fails with a normal diagnostic only when every requested variable fails;
the first failure's code is kept and `details.variableErrors` lists all of them.

C++ file-scope `static` objects, namespace variables, and class static members can be requested
by their DWARF display name (`ep7.port`, `"app::object.id"`) as well as by the mangled ELF name
(`_ZL3ep7`). `--list` shows the mangled names. Untyped `.bss` statics (GCC emits them as `NOTYPE`
symbols at `-O0` without `-fdata-sections`) are listed and typed from DWARF like other variables.

### Same-named statics in several source files

File-scope `static` variables, C++ internal-linkage objects and function statics (`calls.0`) may
have the same name in several compilation units. EmberProbe keeps every copy and names each one
by its compilation unit: `main.c::g_cfg`, `other.c::g_cfg`, or a longer path suffix such as
`a/main.c::s_counter` when two files share a basename. A bare name such as `g_cfg` fails with
`VARIABLE_AMBIGUOUS`; it never falls back to the first symbol. `details.candidates` lists each
candidate's `name`, `sourceFile`, `address` and `size`. Ask the user which source file they mean
when the request does not say, then retry with that candidate's `name`.

Qualify a name GDB-style as `file::name`, with or without quotes: `main.c::g_cfg.mode`,
`"src/b/main.c::s_counter"`, `"'my dir/x.c'::buf[0]"`. The file is matched as a path suffix of the
compilation unit's DWARF source path and must select exactly one unit; otherwise the request fails
with `VARIABLE_AMBIGUOUS` (several units) or `VARIABLE_NOT_FOUND` (none) and lists the candidates.
An unquoted scope must end in a file extension, so C++ names such as `app::counter` are never read
as a file. Quote paths containing spaces or a drive letter. `0x2000abcd::s_counter` selects the
copy at that address. Explicit scalar suffixes still follow the name (`main.c::s_counter:u32`).

`--list` is a raw ELF inventory without DWARF, so it qualifies duplicates by the `STT_FILE`
basename (`sourceFile`, for example `main.c`) and falls back to the address when basenames
collide (`0x20000010::s_counter`); both forms are accepted by reads, writes and `--add-to`.
Duplicate entries carry `elfName` (the raw ELF name), `scope` and `sameNameCount`.
