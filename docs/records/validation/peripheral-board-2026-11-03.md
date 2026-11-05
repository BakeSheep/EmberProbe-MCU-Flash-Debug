# Peripheral register board re-check — 2026-11-03

Re-run of the [2026-11-01 acceptance](peripheral-board-2026-11-01.md) after the sidebar and write-outcome fixes
(commits 4ff2bc4 and ea4cb62).

## Setup

- Windows x64, OS build 10.0.26300; Node.js 24.13.1; isolated VS Code 1.136.1 Extension Host.
- Geehy APM32F407 (CPUID 0x410FC241) with J-Link 1366:0101, serial 20781318, WinUSB. No driver change.
- xPack OpenOCD 0.12.0-7, jlink.cfg + stm32f4x.cfg, SWD, script-default adapter speed.
- SVD APM32F40x.svd and F407_car.elf copied into an isolated workspace; the user's project was not edited.
- Bundle: dist/extension.js SHA-256 8bf227f7261930835746612a452655e5fd93b66a84b3572cdd1f3605511a6877,
  dist/samplingWorker.js SHA-256 c3161153a95b481a110dcde12f73c96dd3b83833a1810e2c1469decb2f7becb7.

No firmware programming, reset or value-changing write ran. Attach halted the core once and the runner
continued it; the paused phase used one explicit pause and continue.

## Results

All steps went through the production Agent dispatcher. RCM.CTRL, RCM.CFG, RCM.AHB1CLKEN, GPIOA.MODE and
GPIOA.IDATA were read twice per state with identical values (0x03037383, 0x0000940A, 0x001000FF, 0xA800A0A0,
0x0000DF0C). Reads and writes did not change the debug state or epoch.

| Access state                | Source                | Reads  | Whole-register same-value write | Field same-value write |
| --------------------------- | --------------------- | ------ | ------------------------------- | ---------------------- |
| Standalone                  | temporary-probe       | Passed | Passed                          | Passed                 |
| Debug running, sampling off | debug-running-openocd | Passed | Passed                          | Passed                 |
| Debug running, sampling on  | debug-running-openocd | Passed | Not requested                   | Not requested          |
| Debug paused                | dap                   | Passed | Passed                          | Passed                 |

- Writes: GPIOA.MODE 0xA800A0A0 → 0xA800A0A0 and GPIOA.MODE.MODE0 0 → 0, each after a fresh one-time
  confirmation. Every result returned verified: true, verification: matched and no stateChangedAfterWrite.
- Sampling stayed in debug-running-sampling before and after the register reads.
- A GPIOA.IDATA write was rejected with PERIPHERAL_WRITE_NOT_ALLOWED before any confirmation.
- chip.read reported the target running before and after standalone access and after detaching.
- Detaching logged the debug adapter "read error" already present in earlier smoke logs (2026-10-20).

The report is test-results/peripheral-board/report.json (SHA-256
71356e6bf914cfb576f06b78dd5f70c0a116844ea39635f97abb968f1a3ac488) and is not committed.

## Limits

The board SVD has only 32-bit registers, so 8/16-bit transfers and the sidebar's width gating were checked by
software tests only. The sidebar's standalone click-only reads and kept write outcomes are webview behaviour
covered by test/peripheral-view.test.js, not exercised on this board. Value-changing writes, other boards and
probes, multicore and Linux/macOS remain unverified.
