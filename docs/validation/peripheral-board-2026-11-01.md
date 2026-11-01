# Peripheral register board acceptance — 2026-11-01

## Setup

- Windows x64, OS build 10.0.26300; Node.js 24.13.1; isolated VS Code 1.136.1 Extension Host.
- Geehy APM32F407, Cortex-M4 r0p1, CPUID 0x410FC241, device ID 0x413, revision 0x9, 1024 KiB Flash.
- J-Link USB 1366:0101, serial 20781318; WinUSB/libwdi, INF oem50.inf. No driver change.
- OpenOCD: xPack 0.12.0+dev-02228-ge5888bda3-dirty (2025-10-04-22:44), jlink.cfg + stm32f4x.cfg,
  SWD, adapter speed left at the existing script default (configuration value 0).
- GDB: Arm GNU Toolchain 15.2.Rel1, GDB 16.3.90.20250906-git.
- SVD: APM32F40x, SHA-256 06e10d815232a7a6205b275c146c1f4dd4f4ef8d1e92dde45e534b5b9d5ac4ba.
- Reference ELF: F407_car.elf, SHA-256 53b4bdbc92d32e9a08a9e7f8556bc70262a9a36d2c073129ca2446b99306142e.
  ELF and SVD were copied into an isolated workspace; the user's project was not edited. The ELF hash identifies
  the symbol file used for attach, not a verification of the image currently programmed on the board.

The user confirmed the board and permitted temporary halt/resume for debug-state setup. Separately, the user
approved exactly six same-value register writes below. No firmware programming, reset or driver switching ran.

## Results

The five 32-bit registers RCM.CTRL, RCM.CFG, RCM.AHB1CLKEN, GPIOA.MODE and GPIOA.IDATA were read twice in each
state. All returned values, access modes and before/after debug states passed. Running-debug reads were also
repeated while ordinary RAM sampling was active, confirming reuse of the managed connection.

| Access state | Register reads | Whole-register same-value write | Field same-value write |
| --- | --- | --- | --- |
| Standalone, sampling off | Passed | Passed | Passed |
| Debug paused | Passed | Passed | Passed |
| Debug running, sampling off | Passed | Passed | Passed |
| Debug running, sampling on | Passed | Not requested | Not requested |

Every approved write used the production Agent dispatcher, requested a fresh one-time confirmation plan,
checked its target/address/width/original value, then supplied that plan's confirmation ID. Each state executed:

- GPIOA.MODE at 0x40020000, 32-bit: 0xA800A0A0 → 0xA800A0A0.
- GPIOA.MODE.MODE0: 0 → 0, with the final 32-bit register still 0xA800A0A0.

All six writes returned verified: true and matching readback. Register operations produced no additional
stopped/continued events and did not change the debug epoch. Attach explicitly halted once for the paused
phase; continue restored execution for the running phase. Cleanup stopped sampling, continued any paused
session, disconnected debugging and released the probe lease. Standalone chip reads reported running before
and after register reads. No writes were retried.

## Findings fixed before the successful run

1. This OpenOCD exposes read_memory/write_memory without the historical ocd_ aliases. Peripheral transactions
   now discover command names with Tcl info commands before register access. Write commands are not retried
   to select an alias. A public-command-only software fixture now covers this case.
2. Background CubeMX discovery changed cubemxPath during an operation and falsely invalidated peripheral
   access. Its generation key now includes only relevant connection, workspace, SVD and selected-probe fields.
   Tests confirm CubeMX/ELF/display-frequency changes do not invalidate access, while probe changes do.

After these fixes, npm run check passed all 484 syntax/test entries; npm run quality passed lint, formatting,
type checking and coverage gates. The bundle rebuilt successfully, and the complete software Extension Host
E2E entry point passed using cached VS Code 1.136.1 with a copied workspace and writable isolated temp/profile
directories. Software check, quality and E2E logs are retained alongside the board report.

## Evidence and limits

Local evidence is generated under test-results/peripheral-board/: read-acceptance.json, inputs.json, logs,
and preserved failure reports. The one-off runner and exact approval assertions are under output/peripheral-board/.
These generated artifacts are intentionally not committed.

- Successful report SHA-256: ca106d993ca111e360f01e634a22a7eba40feb12a72cc6fcbdcfa3b53d492daf.
- Tested extension bundle SHA-256: f1f9f00846066d0c6f58bcb0ba4e1bd7be1b8ab5cd295ad6d6599622273053ce.
- Tested sampling Worker SHA-256: 01d70895b5dfdc8d75ef3641c3054c35725eb5e7a63ed13cdf34eab8321174f9.

This establishes ordinary 32-bit reads and same-value whole-register/field write transactions on this one
board/probe combination. It does not establish deliberate value changes, 8/16-bit hardware transfers, 64-bit
running access, special side-effect registers, multicore, other boards/probes or native Linux/macOS behavior.
Endpoint state and DAP-event observations do not measure bus contention or provide an electrical trace of SWD.
