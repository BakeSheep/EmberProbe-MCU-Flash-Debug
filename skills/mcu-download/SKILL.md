---
name: mcu-download
description: Detect and download embedded MCU firmware with OpenOCD. Use when the user asks an agent to flash, program, burn, or download the current workspace ELF firmware to an attached MCU through ST-Link, J-Link, CMSIS-DAP, XDS110, or Nu-Link.
---

# MCU Download

Use the bundled `scripts/download.ps1` from this skill directory. Do not construct an OpenOCD shell command manually.

1. Run a preflight without `-Execute` from the workspace root:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File <skill-dir>/scripts/download.ps1 -Workspace <workspace>
   ```

2. Report the detected ELF, target, probe, and OpenOCD executable. If detection is incomplete, stop and ask the user to connect/select the missing item. Never guess a target configuration.
3. When the user explicitly asked to download or flash, rerun the same command with `-Execute`.
4. Report the ELF SHA-256 fingerprint, OpenOCD's exit code, and concise result. On failure, include the actionable tail of its output.

The script first reuses EmberProbe's configured ELF, MCU target, probe, and OpenOCD executable through the Agent Bridge. Missing values fall back to workspace/USB auto-detection: newest ELF by modification time, MCU hints from `.ioc`, CMake, and linker files, and the attached debug probe. On Windows it falls back to `pnputil` when `Get-PnpDevice` is unavailable. Explicit `-Elf`, `-Target`, `-Probe`, or `-OpenOcd` values always take precedence.
