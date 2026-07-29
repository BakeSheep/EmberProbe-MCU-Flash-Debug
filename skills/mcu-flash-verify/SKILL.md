---
name: mcu-flash-verify
description: Verify that the firmware currently in MCU flash matches a local ELF, using OpenOCD verify_image over ST-Link, J-Link, CMSIS-DAP, XDS110, or Nu-Link. Use when the user asks whether the board is running the latest build, wants to confirm a download succeeded, or suspects the on-chip firmware differs from the workspace ELF.
---

# MCU Flash Verify

Run `scripts/verify.ps1` from this skill directory with PowerShell. It first reuses EmberProbe's configured ELF, OpenOCD target, probe, and executable; missing values fall back to auto-detection exactly like the mcu-download skill.

First run detection only and show the JSON result to confirm what will be compared:

```powershell
pwsh -File <skill-dir>/scripts/verify.ps1 -Workspace <workspace>
```

Then execute the verification:

```powershell
pwsh -File <skill-dir>/scripts/verify.ps1 -Workspace <workspace> -Execute
```

Override detection with `-Elf`, `-Target`, `-Probe`, or `-OpenOcd` when needed.

## Behavior

- Verification is read-only for the flash, but the core must be halted while comparing: the script halts, runs `verify_image`, then restores the original run state.
- Do not run it while EmberProbe is sampling, downloading, or debugging — the probe can only be owned by one process (same rule as mcu-download).
- The final JSON line contains `verified` (true/false), `elf`, and `elfSha256`. Exit code 0 means the flash matches the ELF; exit code 1 with `verified: false` means contents differ — report the mismatch detail line (e.g. checksum mismatch address) and suggest re-downloading with mcu-download.
- OpenOCD connection errors (probe not found, target unpowered) surface as raw OpenOCD output; summarize the failing line for the user.
