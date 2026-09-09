---
name: mcu-variables
description: Read, monitor, trend, export, or explicitly modify MCU variables resolved from ELF and DWARF data. Use for live values, structs, arrays, runtime trends, CSV history, and requested variable tuning.
---

# MCU Variables

## Before you run

- **Applies to**: listing, reading, sampling, trending, or exporting variables, and — only on explicit request — modifying one.
- **Requires**: the EmberProbe Agent Bridge; live reads/writes also need a connected, powered target. Listing ELF symbols and exporting CSV from an existing chart do not touch the probe.
- **Preconditions**: an ELF is selected; live sampling needs the probe to be free; a write needs explicit user confirmation with a fresh `confirmationId`.
- **Side effects**: reads are non-intrusive; `scripts/write.js` changes target RAM and verifies it by readback.
- **Success evidence**: reads return resolved values (preserve exact 64-bit `valueText`); writes return the readback verification. A read or export success does not prove the firmware behaves correctly.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

Choose the narrowest operation that satisfies the request:

- For listing, reading, sampling, trending, chart integration, or CSV export, read [references/reading.md](references/reading.md) and use `scripts/read.js`.
- Only when the user explicitly asks to set, tune, override, or otherwise modify a variable, read [references/writing.md](references/writing.md) and use `scripts/write.js`.

Never turn a read or monitoring request into a write. A write request starts planning but is not itself approval to execute the returned write plan. Preserve exact 64-bit `valueText` fields when reporting values, and base failures on the structured stderr diagnostic instead of guessing a probe or service cause.
