---
name: mcu-elf-analyze
description: Statically analyze the configured firmware ELF through EmberProbe - Flash and RAM usage per section plus the largest functions and variables. No probe or hardware needed. Use when the user asks how much Flash/RAM the firmware uses, what occupies the most space, why the binary grew, or wants a memory footprint report.
---

# MCU ELF Analyze

Use `scripts/analyze-elf.js` from this skill directory. This is a pure static analysis of the workspace's configured ELF — it never touches the probe or the target, so it works with no hardware attached and does not conflict with sampling or downloading.

```powershell
node <skill-dir>/scripts/analyze-elf.js --workspace <workspace>
node <skill-dir>/scripts/analyze-elf.js --workspace <workspace> --top 30
```

`--top` limits the largest-symbol ranking (default 20, max 100).

## Interpreting the result

The JSON on stdout contains:

- `flash`: total bytes and per-section list of everything programmed to Flash (`.isr_vector`, `.text`, `.rodata`, plus the load copy of `.data`), addresses are LMAs.
- `ram`: total bytes and per-section list of runtime RAM usage (`.data`, `.bss`, etc.), addresses are VMAs. `.data` legitimately appears in both lists.
- `topSymbols`: largest functions and objects with `kind`, `section`, `size`, `address`.

Report totals in human units (KiB) and highlight the top consumers. To compute a Flash utilization percentage, combine `flash.total` with the chip's `flashSize` from the mcu-chip-info skill — do not guess the chip capacity from the ELF.

Note: static RAM only. Heap and stack usage are runtime properties and are not included; mention that when the user asks about "free RAM".

## Failure diagnostics

On failure, parse the JSON `diagnostic` on stderr. `ELF_NOT_CONFIGURED` means no ELF is selected (use mcu-config), `ELF_READ_FAILED` means the file is missing or being rebuilt.
