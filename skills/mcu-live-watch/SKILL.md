---
name: mcu-live-watch
description: Read current or sampled scalar MCU global variables from an ELF by connecting to EmberProbe's local OpenOCD Tcl-RPC service. Use when the user asks an agent to inspect, monitor, sample, compare, or report live embedded variable values while firmware is running.
---

# MCU Live Watch

Use `scripts/read-live.js` from this skill directory. Do not start another OpenOCD instance; EmberProbe and a second server cannot own the same probe simultaneously.

1. Ask the user to start EmberProbe sampling in the sidebar or graph panel. The script connects to its local Tcl port, default `6666`.
2. Locate variables before reading when names are uncertain:

   ```powershell
   node <skill-dir>/scripts/read-live.js --workspace <workspace> --list
   ```

3. Read one or more variables by exact name:

   ```powershell
   node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables counter:u32,temperature:f32 --count 5 --interval 200
   ```

4. Parse the JSON Lines output. Report the ELF path, timestamped values, requested types, and any read errors concisely.

Supported scalar types are `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, and `f32`. The script infers a type only for 1-, 2-, or 4-byte symbols. Require an explicit supported type for any intentional scalar view of a larger symbol. Do not describe a structure or array as fully read: EmberProbe currently does not expand DWARF members, offsets, dimensions, or elements.

Use `--elf <path>` to override automatic newest-ELF selection, `--port <number>` for a non-default Tcl port, and `--count`/`--interval` for repeated samples.
