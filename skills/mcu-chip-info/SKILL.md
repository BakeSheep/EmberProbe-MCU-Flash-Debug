---
name: mcu-chip-info
description: Selectively read attached MCU identity, debug-link, or runtime information through EmberProbe. Use only when the user asks about the connected chip, core, UID, flash size, debugger, transport, voltage, target state, or CPU registers.
---

# MCU Chip Information

Use `scripts/read-chip.js` from this skill directory. EmberProbe owns the probe and enforces mutual exclusion.

```powershell
node <skill-dir>/scripts/read-chip.js --workspace <workspace> --section identity
node <skill-dir>/scripts/read-chip.js --workspace <workspace> --fields core,series,deviceId,flashSize
```

Sections are `identity`, `debug`, and `runtime`. If neither `--section` nor `--fields` is supplied, read `identity`. Request only the fields needed to answer the user. If EmberProbe reports that the probe is busy, do not start another OpenOCD process.

On failure, parse the stderr JSON diagnostic and use its `error.code`, `likelyCause`, `suggestedActions`, and `details.openocdTail`. Do not replace a specific probe/target/configuration diagnosis with a generic “service not running” explanation.
