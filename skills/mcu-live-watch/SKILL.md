---
name: mcu-live-watch
description: Read current or sampled MCU global variables from an ELF by connecting to EmberProbe's local OpenOCD Tcl-RPC service. Handles scalars plus struct members and array elements via path syntax. Use when the user asks an agent to inspect, monitor, sample, compare, or report live embedded variable values while firmware is running.
---

# MCU Live Watch

Use `scripts/read-live.js` from this skill directory.

## Fast path: read current values

Pass the variable names directly:

```powershell
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables Tick,sinx
```

Do not search source files for their declarations first, do not ask the user to start sampling, and do not add type suffixes unless the user explicitly requests a reinterpretation. EmberProbe reads the latest ELF and DWARF information, resolves a uniquely matching name case-insensitively, and infers `u8/i8/u16/i16/u32/i32/f32`.

If live sampling is already active, EmberProbe reuses that connection. Otherwise it starts the configured probe, reads once, and closes it immediately. Report the returned values, resolved names, types, and whether `source` is `active-sampling` or `temporary-probe`.

Only use `--list` if EmberProbe reports that a name is missing or ambiguous:

```powershell
node <skill-dir>/scripts/read-live.js --workspace <workspace> --list
```

## Struct members and array elements

When firmware is built with DWARF debug info (Debug build, not stripped), EmberProbe
expands structs, unions, and arrays. Read individual members or elements using path syntax
in `--variables` (no type suffix; the type is inferred from DWARF):

```powershell
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables sensor.x,sensor.y
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables buf[0],buf[1:5]
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables buf[*]
```

- `sensor.x` — a single struct/union member (supports nesting, e.g. `sensor.pos.y`).
- `buf[0]` — one array element. A single member/element is returned like a scalar
  (`value`, `type`, `address`), so it works with `--trend`.
- `buf[1:5]` — a half-open range (indices 1..4). `buf[*]` — the whole array.
- The whole variable name (e.g. `sensor` or `buf`) returns a `tree` (nested members /
  elements). Trees are for reporting, not `--trend`.

These paths require the extension bridge (the fast path above); they are not available with
`--elf`/`--port` direct reads.

## Add variables to EmberProbe

```powershell
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables counter --add-to sidebar
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables temperature --add-to chart
```

`--add-to` accepts `sidebar`, `chart`, or `both`. Adding does not start sampling. Combine it with `--read`, `--count`, or `--trend` only when the user also asks to read immediately.

## Trends

For a trend, use `--trend`; it defaults to 10 samples and reports rising, falling, stable, or volatile:

```powershell
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables counter --trend --interval 200
```

Do not ask the user to start sampling. If sidebar/chart sampling is active, EmberProbe reuses that connection without changing its lifecycle. Otherwise EmberProbe starts an Agent-owned temporary sampling session, mirrors its startup/progress/stop state to the sidebar and chart, and releases the probe automatically when the requested samples are complete. The user may also stop that temporary session from either UI.

The trend command emits one compact summary object containing the latest values and rising, falling, stable, or volatile analysis. Do not request raw samples unless the user specifically needs them.

## Failure diagnostics

On failure, parse the single JSON object written to stderr. It has `type: "diagnostic"` and an `error` object containing `code`, `category`, `stage`, `likelyCause`, `retryable`, `suggestedActions`, and optional `details.openocdTail`.

Base the response on that diagnostic. In particular, distinguish `PROBE_NOT_FOUND`, `TARGET_NOT_CONNECTED`, `TARGET_UNPOWERED`, `PROBE_BUSY`, `TCL_PORT_IN_USE`, configuration/ELF errors, and Bridge errors. Never infer that “the active Tcl service is not running” merely because a read failed, and never quote an older instruction that asks the user to start sampling. Temporary sampling is EmberProbe's responsibility.

When you read a whole struct or array, EmberProbe expands DWARF members, offsets, dimensions, and elements into a `tree`. Report that tree concisely. If DWARF layout is unavailable (stripped or non-Debug build), a composite variable cannot be expanded; say so and suggest a Debug build. Parse the JSON Lines output and report results concisely.
