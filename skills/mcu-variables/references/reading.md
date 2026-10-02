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

Use `--list` only after a missing or ambiguous name. DWARF paths support members and array selections such as `sensor.pos.y`, `buf[0]`, `buf[1:5]`, and `buf[*]`. Whole composites return a reporting tree and cannot be trended.

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
Running multi-read observations are not atomic snapshots. For task-local variables or
GDB's paused object presentation and paging, read
[../../mcu-debug-control/references/paused-inspection.md](../../mcu-debug-control/references/paused-inspection.md).

For trends, use `--trend`; it defaults to ten samples. EmberProbe reuses an existing compatible connection or owns and releases a temporary sampling session:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables counter --trend --interval 200
```

Use `--add-to sidebar|chart|both` only when the user asks to update the EmberProbe UI. Adding does not start sampling. Export an open chart's real history with `--export-csv`; prefer `--last <seconds>` or complete ISO 8601 UTC timestamps, and keep `--output` relative to the workspace:

Agent CSV reads the chart's full sampling archive. Column headers include the decoded type so history remains clear if a watch's type changes. Results larger than 64 MiB are rejected explicitly; use the chart's archive export dialog for larger files. `historyTruncated: true` means the archive hit its size cap and stopped recording while the chart kept drawing, so the CSV covers less than the requested range: compare `from`/`to` with what was asked and report the gap instead of presenting the rows as complete.

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --export-csv --variables counter,temperature --last 30 --output exports/live.csv
```

If an EmberProbe-managed debug target is running, reads are limited to writable allocated ELF RAM. A paused session may use DAP memory. Never pause a user-managed session implicitly. Report resolved names, inferred types, exact text values where present, source, and concise trend or composite results.

On failure, use the diagnostic's `error.code`, `likelyCause`, `suggestedActions`, and `details`. Distinguish probe absence, target connection or power, probe ownership, Tcl port, configuration/ELF, and Bridge errors.
