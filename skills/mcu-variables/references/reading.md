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

For trends, use `--trend`; it defaults to ten samples. EmberProbe reuses an existing compatible connection or owns and releases a temporary sampling session:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables counter --trend --interval 200
```

Use `--add-to sidebar|chart|both` only when the user asks to update the EmberProbe UI. Adding does not start sampling. Export an open chart's real history with `--export-csv`; prefer `--last <seconds>` or complete ISO 8601 UTC timestamps, and keep `--output` relative to the workspace:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --export-csv --variables counter,temperature --last 30 --output exports/live.csv
```

If an EmberProbe-managed debug target is running, reads are limited to writable allocated ELF RAM. A paused session may use DAP memory. Never pause a user-managed session implicitly. Report resolved names, inferred types, exact text values where present, source, and concise trend or composite results.

On failure, use the diagnostic's `error.code`, `likelyCause`, `suggestedActions`, and `details`. Distinguish probe absence, target connection or power, probe ownership, Tcl port, configuration/ELF, and Bridge errors.
