---
name: mcu-config
description: Read or change EmberProbe workspace configuration and immediately synchronize it to the sidebar. Use when the user asks an agent to select or change the ELF, debugger probe, MCU target, SVD, OpenOCD path, sampling interval, Tcl port, or sample history limit.
---

# MCU Configuration

Use `scripts/config.js` from this skill directory. Never edit VS Code storage or EmberProbe files directly.

1. Read the current configuration before changing it:

   ```powershell
   node <skill-dir>/scripts/config.js --workspace <workspace> --get
   ```

2. Change only values explicitly requested by the user:

   ```powershell
   node <skill-dir>/scripts/config.js --workspace <workspace> --set debugger=cmsis-dap.cfg,mcu=stm32f4x.cfg
   ```

3. Supported keys are `elf`, `debugger`, `mcu`, `svd`, `openocdPath`, `sampleIntervalMs`, `tclPort`, and `maxSamples`.
4. Report the normalized configuration returned by EmberProbe. The extension validates paths, configuration names, numeric ranges, and synchronizes the sidebar immediately.
5. On failure, parse the stderr JSON diagnostic and report its `error.code`, `likelyCause`, and `suggestedActions`. Do not guess a hardware or service cause for configuration-validation errors.
