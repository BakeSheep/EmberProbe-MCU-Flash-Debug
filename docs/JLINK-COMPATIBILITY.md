# J-Link / OpenOCD compatibility verification

Verified locally on 2026-09-17 using Windows x64, Node.js 24.13.1 and VS Code 1.136.1.

## Confirmed defects and fixes

| Finding | Resolution | Evidence |
| --- | --- | --- |
| Synchronous and asynchronous Windows realpath calls returned different drive casing, invalidating the same ELF authorization | Use native canonical paths and fold only the drive spelling; keep path components case-sensitive | Regression exercises confirmation and execution with a lowercase drive, Unicode/spaces, and a directory junction |
| USB NOT_FOUND / NOT_SUPPORTED errors became generic startup failures | Shared classification with platform/probe-specific advice; classify retained output before truncating display | Fragmented USB error followed by 30 log lines retains its cause across flash, query and live/debug entrypoints |
| Normal voltage such as 3.300000 V was reported as unpowered | Parse the numeric voltage, with the existing 0.5 V threshold | Normal, unknown, zero and low-voltage cases |
| No way to select SWD/JTAG before loading the target | Shared argument construction and `emberprobe.transport`; default remains `auto` | All process entrypoints put explicit transport between interface and target; changed transport invalidates flash confirmation |
| Extension and Skills used different launch/path logic | Shared resolver shipped in the Skills manifest; validate executable files and scripts | Installation-layout, missing-script, directory-on-PATH and Windows wrapper checks |
| Multiple probe types silently selected by priority | Return candidates and require a selection when no explicit probe exists | Mixed J-Link/ST-Link detection yields no implicit selection |

## Local verification

- `npm run check`: 196 files checked, zero failures (syntax checks and normal tests).
- `npm run quality`: lint, formatting, JavaScript type checking and coverage gates passed. Coverage: 84.80% lines/statements, 88.86% functions, 76.43% branches.
- `npm run bundle`: passed. The sandbox initially denied esbuild access to parent directories; the approved run outside the sandbox succeeded.
- `npm run test:e2e`: passed activation, contributed settings, packaged worker startup and secured Webview smoke tests.
- Final focused tests additionally verify the CLI transport override and invalid-transport rejection.
- Windows, Linux and macOS diagnostic policies are unit-tested. Linux/macOS OS execution remains for the existing CI matrix; those systems were not run locally.

## Hardware status and remaining limits

No board was designated for this task; no probe connection, flash operation or driver replacement was performed. Old J-Link hardware with the legacy SEGGER driver, J-Link with WinUSB, and ST-Link/CMSIS-DAP board regressions remain **hardware-unverified**. Windows 8.3 aliases and UNC shares were not separately exercised on physical storage.

OpenOCD USB compatibility is separate from Commander connectivity. Consult [SEGGER's OpenOCD notes](https://kb.segger.com/OpenOCD) before changing a driver. This change diagnoses a possible legacy-driver conflict; it does not add a native SEGGER backend or make that driver compatible.

Same-model probe selection by serial number, complete multi-root workspace isolation, vendor-specific OpenOCD builds and board-dependent transport capabilities remain outside this fix. `auto` preserves script behavior, not automatic wiring detection. An explicit unsupported transport fails without retrying another transport.

Hardware acceptance should record probe hardware/firmware, OS driver binding, OpenOCD version/scripts and MCU model. Use a designated board: verify USB failure diagnostics first, then SWD query/live/debug behavior, and only perform flashing with explicit authorization for that board. Do not infer hardware success from the simulated-process tests.
