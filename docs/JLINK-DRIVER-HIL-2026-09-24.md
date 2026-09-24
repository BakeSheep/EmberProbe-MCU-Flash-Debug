# Windows J-Link driver configuration: local hardware record

Date: 2026-09-24. Windows build: 26300.9550, x64. Probe: `USB\VID_1366&PID_0101\000020781318`, decimal serial `20781318`, J-Link V9 firmware compiled 2021-05-07, hardware version 9.70. OpenOCD: Sysprogs 0.12.0 (2026-03-02).

This run used an unsigned local MSVC development helper with the SHA-256 of its paired `libwdi.dll` pinned into the compiled executable. It is **not** a signed VSIX release acceptance test. No target configuration, firmware write or explicit reset was used.

| Check | Result |
| --- | --- |
| Initial SEGGER binding | Device instance used `jlink oem59.inf`; provider Segger, driver version 2.70.8.0. |
| Initial local build failure | VS Code renderer log reported `The bundled libwdi library is unavailable` after UAC. The helper was compiled with the all-zero placeholder DLL hash; the device remained on `jlink oem59.inf`. |
| Rebuilt native helper | MSVC rebuilt libwdi and the helper with the actual DLL SHA-256 pinned. The source header was restored to its placeholder after compilation so release signing can pin the signed DLL. |
| Native install | Helper returned exit 0; the same instance changed to `WinUSB oem80.inf`. |
| OpenOCD with WinUSB | Interface-only `interface/jlink.cfg`, `transport select swd`, `init`, `shutdown` returned exit 0; J-Link V9 detected and target voltage was 3.270 V. |
| Native restore | Helper returned exit 0; the same instance returned to `jlink oem59.inf`. |
| Extension driver service | `ProbeDriverService.ensure()` classified the same instance as `repair`, installed WinUSB, waited for re-enumeration and returned inventory with `WinUSB oem81.inf`. This is the final device state. |
| OpenOCD after service install | The same interface-only check returned exit 0; J-Link V9 detected and target voltage was 3.282 V. |

Still required for release acceptance: signed helper and signed VSIX, sidebar/Bridge original-request completion, Windows 10 x64, a composite-interface J-Link, UAC refusal and policy rejection, and Ozone interoperability. The unsigned development helper is for local testing only.

## STM32H750 connection follow-up

The user tested `stm32h7x.cfg` with the same J-Link and WinUSB binding. Sysprogs OpenOCD initially opened the probe and reported `VTarget = 3.279 V`, then failed at the SWD debug port with `Error connecting DP: cannot read IDR`. Debug-level output included `SWD ack not OK: 7 JUNK`; no libusb access error was reported. Lowering the adapter speed to 100 kHz did not immediately clear the fault. A user retry after manually resetting or power-cycling the board also failed. This J-Link reports `adapter has no srst signal`, so OpenOCD cannot assert target reset through it.

The failure was intermittent: earlier Sysprogs logs with this configuration alternated between failed and successful DPIDR reads. A read-only initialization with the bundled xPack OpenOCD succeeded at 100 kHz. Subsequent alternating xPack and Sysprogs initializations at 100 and 4000 kHz all succeeded, so the available evidence does not isolate an OpenOCD build defect. The extension's own chip-read function then returned Cortex-M7, device ID `0x450`, and the target UID at 4000 kHz; five repeated preflight-and-read runs succeeded. Preflight took 225–278 ms and the OpenOCD read took 85–96 ms per run on this host. The user independently confirmed that chip read and managed debugging now start successfully in the installed extension.

The observed `cannot read IDR` belongs to intermittent target SWD communication after the USB interface opens. The available checks do not establish whether the cause is target state, wiring, probe behavior, or another board-level condition. No automatic target reset, driver rollback, or extra read retry was added for this observation.
