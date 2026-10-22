# EmberProbe HIL runners

The HIL workflow flashes real hardware. It is disabled until the repository variable `HIL_ENABLED` is set to `true`.

Provision one self-hosted runner for each label:

- `emberprobe-hil`, `stm32f1`
- `emberprobe-hil`, `stm32f4`
- `emberprobe-hil`, `nrf52`
- `emberprobe-hil`, `rp2040`

Create matching GitHub Environments named `hil-stm32f1`, `hil-stm32f4`, `hil-nrf52`, and `hil-rp2040`. Each environment must define:

- `EMBERPROBE_HIL_OPENOCD`: absolute OpenOCD executable path on that runner.
- `EMBERPROBE_HIL_PROBE`: interface config relative to OpenOCD scripts, such as `cmsis-dap.cfg`.
- `EMBERPROBE_HIL_TARGET`: target config, such as `stm32f1x.cfg`.
- `EMBERPROBE_HIL_TRANSPORT`: explicit `swd` or `jtag`, matching the board wiring.
- `EMBERPROBE_HIL_PROBE_SERIAL`: physical J-Link serial number. Required for unattended J-Link runs when inventory cannot establish one unique device; setting it explicitly is recommended for every dedicated runner.
- `EMBERPROBE_HIL_ADAPTER_SPEED_KHZ`: adapter speed in kHz; `0` or unset keeps the interface/target script default.
- `EMBERPROBE_HIL_ELF`: absolute path to the board's dedicated smoke-test ELF.

Use dedicated, non-production boards. The workflow requires `EMBERPROBE_HIL_CONFIRM=YES`, verifies the ELF after programming, resets the target, records its SHA-256 fingerprint, and enforces a two-minute timeout.

The runner uses the production OpenOCD capability preflight and argument builder: interface, serial, transport, target, then speed. A zero exit code or `shutdown command invoked` alone does not pass verification. The dedicated `EP_HIL_VERIFY_OK` marker must be emitted after the program/verify command completes. JSON results include the selected serial, transport and speed.

J-Link hardware validation remains separate from software tests. Record the exact OB board/model, firmware, serial, OS, USB interface driver, OpenOCD build, transport, speed and result for each run. The labels “V9” and “V10” alone do not establish OB compatibility. Include single-probe SWD, explicit JTAG, multiple probes, duplicate/unreadable serials, selected probe unplugged, Ozone holding the device, and reconnect after Ozone exits. Do not replace USB drivers as part of this runner.

## Windows driver configuration acceptance (separate from the flashing runner)

Use a dedicated Windows 10 and Windows 11 x64 machine and a signed VSIX from the release pipeline. This procedure changes the Windows USB driver; it never runs `npm run test:hil`, flashes firmware or sends an explicit target reset. Capture PnP instance ID, service, provider and INF before and after each case with the read-only `probe.list` Bridge method, and confirm the changed interface is the selected one.

1. On a supported `1366:0101` J-Link using the SEGGER `jlink` service, select `jlink.cfg`. Confirm the VS Code warning asks for WinUSB and the driver dropdown beside **Select Debugger** shows **SEGGER**. Attempt a chip read, sampling and debugging; each must report the unsupported driver without opening the target or requesting UAC. Select **WinUSB**, accept the Windows UAC prompt, then start a sidebar chip read. Confirm the original driver package and exact instance ID were saved under `%ProgramData%\EmberProbe\drivers`, WinUSB is active on that instance, and the read completes.
2. Repeat with a composite J-Link. Confirm only the identified J-Link debug child interface changes; the USB composite parent and VCOM/serial children keep their original drivers. An ambiguous or missing debug child must stop before UAC.
3. Repeat with a probe already using WinUSB. Confirm no helper installation or UAC occurs and the original read completes.
4. From the driver dropdown beside **Select Debugger**, select **SEGGER**. Confirm the same device instance uses the saved SEGGER driver again. Repeat with OpenOCD temporarily unavailable to check that restore does not depend on its configuration.
5. On a dedicated probe still using SEGGER, decline UAC and verify the driver remains unchanged. Repeat with a Windows driver policy that blocks installation and record the exact diagnostic and resulting driver state.

For every failed installation, query `probe.list` before another attempt. If the result is unknown or rollback failed, inspect the actual Windows PnP state and backup record; do not automatically repeat a driver mutation. Record the VSIX hash, signed helper and libwdi signature status, Windows build, J-Link model/serial and OpenOCD version with the test result.

## H750 WinUSB fast-path SWD comparison (read-only)

Use a dedicated H750 board and one J-Link with exclusive access. Keep the same USB cable, SWD wiring, target power, xPack OpenOCD executable, `jlink.cfg`, `stm32h7x.cfg`, SWD transport and adapter speed throughout. Close VS Code debugging and other J-Link clients before each series. This procedure only invokes OpenOCD `init; shutdown`; it does not flash firmware, request a target reset, change adapter speed between runs or retry a failed run. Do not use the flashing HIL runner for this comparison.

Run `scripts/measure-jlink-swd.js` from the repository root with Node.js 20+. It selects the exact J-Link serial and instance ID, checks the instance is bound to WinUSB before every run, and records each complete OpenOCD `-d3` stdout/stderr stream, exit code, elapsed time, VTarget and SWD error/ack text. Choose a fresh output directory and preserve it for all phases. For example, on the documented H750 setup:

```powershell
$openocd = 'D:\software\openOCD\xpack-openocd-0.12.0-7\bin\openocd.exe'
$instance = 'USB\VID_1366&PID_0101\000020781318'
$out = 'C:\Temp\emberprobe-h750-swd-acceptance'
node scripts/measure-jlink-swd.js --openocd $openocd --instance $instance --serial 20781318 --speed 1800 --runs 10 --phase baseline --output $out
```

1. With WinUSB already bound, run the **baseline** series without changing the driver. Save the Windows build, board/probe model and firmware, wiring, target power, VSIX/helper hashes, OpenOCD version and the initial `probe.list` result with the output directory.
2. Restore the saved SEGGER driver on that exact instance through the extension, then select WinUSB to exercise the fast path. Start the **after-switch** series immediately after the extension reports interface readiness, with the same command except `--phase after-switch`. Record the extension's `helperMs`, `pollMs`, `readyMs` and `totalMs`, plus the resulting instance ID, provider and INF. Do not unplug or power-cycle between the switch and this series.
3. If a probe unplug/replug or board power cycle is needed for diagnosis, run it as a separate control with `--phase probe-replug` or `--phase board-power-cycle`. Never merge these results into the baseline or immediate-after-switch series.

Compare all 10 individual outcomes and their timing distributions, not just the aggregate success rate. A failure confined to the short period after the fast-path switch calls for disabling that path and restoring the original libwdi installation flow while investigating re-enumeration/readiness timing. The same `cannot read IDR` in the baseline calls for SWD wiring, target state and probe investigation. Do not add automatic speed changes, resets, retries or driver rollback based on one IDR failure. Preserve the raw logs and identify any skipped/invalid runs explicitly.

## FreeRTOS task awareness acceptance (separate from the flashing runner)

`npm run test:hil` only flashes and verifies; it does not start GDB or speak DAP. RTOS task discovery is therefore accepted manually. Use a dedicated board running a FreeRTOS firmware with at least three tasks of differing priority, one of which can be deleted on demand, plus a probe with exclusive access. Record the board and probe model, probe firmware and serial, OS build, OpenOCD build and version, the `rtos` value under test, the FreeRTOS-Kernel version, and the relevant `FreeRTOSConfig.h` macros (`configUSE_TRACE_FACILITY`, `configUSE_16_BIT_TICKS`, `configMAX_PRIORITIES`) together with whether `uxTopUsedPriority` survived linking. Record the observed result of each step, not just pass/fail, and note explicitly whether task names or `Thread N` appeared.

Set `emberprobe.rtos` (or the `rtos` key in `launch.json`) and start an `attach` session from the sidebar.

1. Confirm the CALL STACK lists every task rather than a single thread, and record whether names are shown. A single `Thread 1` means OpenOCD found no kernel symbols; check `uxTopUsedPriority` before blaming the extension.
2. Expand a task that is **not** the one that stopped. Confirm its frames and locals belong to that task by comparing a task-local variable against a value the firmware prints over UART.
3. With the call stack still showing a non-stopped task, step over. Confirm the task that advances is the one that stopped, not the one being viewed, and that the response carries an explicit task ID.
4. Hit a breakpoint inside one task. Confirm the stop is attributed to that task and that other tasks are shown as stopped too.
5. Delete a task while its stack is open, then step. Confirm `DEBUG_TASK_EXITED` rather than a step on some other task, and confirm the CALL STACK drops the task without a reload.
6. Restart the session, then reset the target before `vTaskStartScheduler` runs. Confirm exactly one thread is reported and no task ID is invented.
7. Set `rtos` to `FreeRTOs` and start a session. Confirm `OPENOCD_RTOS_INVALID` with the suggested actions, and confirm no probe session, lease or live-sampling state is left behind. Repeat with a valid name the target rejects and record OpenOCD's own message.
8. On a dual-core part, if one is available, confirm only the current target is configured and record which core was selected.
9. On a plain non-RTOS ELF with `rtos` unset, run attach, breakpoint, inspect, step, continue, restart and disconnect. Confirm the behaviour is indistinguishable from the previous release and that standalone live sampling issues no `-rtos` argument.

This procedure changes no USB driver and adds no automatic retries, resets or speed changes. Do not merge its results into the flashing runner or the H750 SWD comparison.

## H750 paused C++ display acceptance (read-only attach)

`node test/hil/run-cpp-paused.js` starts an isolated VS Code development host against the current bundle. It attaches to already flashed firmware, halts it, reads `app::g_statusText`, `app::g_trend` and `app::g_sensorOwner` through real DAP, then continues and disconnects. It never downloads firmware, resets the target or writes variables. Build with `npm run bundle` first; ensure the selected probe has no debugging, sampling or other owner. The user project is never edited.

Set `CPP_BOARD_ELF` and `CPP_BOARD_GDB` to absolute paths, `CPP_BOARD_PROBE` to an interface filename such as `jlink.cfg`, and `CPP_BOARD_TARGET` to a target filename such as `stm32h7x.cfg`. These filenames are relative to their OpenOCD `interface` / `target` directories; do not prefix them with those directory names. Optional `CPP_BOARD_RTOS=FreeRTOS` enables task awareness; an empty value isolates STL inspection from RTOS discovery. The runner uses the normal managed OpenOCD service and probe lease.

Results and failure details are written to `test-results/cpp-board.json`. The acceptance only proves the three named types present in this firmware; maps, tuples, other wrappers, large pages and writes are covered separately by repository fixtures. If attach or continue times out, inspect the reported state before another action. A failed run does not prove the target resumed.

## Running-write acceptance (managed debug, already flashed board)

`node test/hil/run-runtime-write.js` starts an isolated VS Code development host, attaches to a board running the probe-lab stress firmware (`probe_lab_stress.c`), continues it and enables managed runtime sampling of the `g_stressFrames`, `g_stressPacked`, `g_stressCh*` and related load variables. It then writes `g_stressWriteF32` while changing the sidebar watch list, the sampling rate and archive backpressure, and finally while a function breakpoint on `ProbeLab_StressBreakpoint` (hit every 3 s) stops the target. It only writes that RAM variable; it never downloads firmware or resets the target. Run `npm run bundle` first and give the runner exclusive use of the probe.

Set `EMBERPROBE_HIL_CONFIRM=YES`, `RUNTIME_BOARD_ELF`, `RUNTIME_BOARD_GDB`, `RUNTIME_BOARD_PROBE` (for example `cmsis-dap.cfg`) and `RUNTIME_BOARD_TARGET` (for example `stm32h7x.cfg`); optional `RUNTIME_BOARD_OPENOCD`, `RUNTIME_BOARD_TRANSPORT`, `RUNTIME_BOARD_PROBE_SERIAL`, `RUNTIME_BOARD_ADAPTER_SPEED_KHZ`, `RUNTIME_BOARD_ROUNDS` and `RUNTIME_BOARD_STOPS`. `RUNTIME_BOARD_EXPECT=fixed` asserts that reconfiguration never fails a write, that every write is verified and that breakpoint interruptions report `DEBUG_STATE_CHANGED` with `details.written`. Without it the run only records outcomes, which is how a baseline checkout is compared: point `RUNTIME_BOARD_EXTENSION` at its bundled root and set `RUNTIME_BOARD_LABEL`. Results go to `test-results/runtime-write-<label>.json`. The run fails rather than passing when no runtime samples arrive, because the race needs real sampling load.

## Automated smoke matrix (Windows + Linux through WSL2)

`npm run test:hil:smoke` runs the everyday board checks for each configured board/probe profile in an isolated VS Code development host, through the same Agent Bridge dispatcher the skills use (flash and write confirmations are requested and supplied, never bypassed). Each profile performs, in order:

1. `config.set`, `probe.list`, `chip.read`, `flash.execute` with verify, a separate `flash.verify`, `fault.read` (no fault may be latched), `variables.read`, and a confirmed `variables.write` round trip (write, read back, restore the original value).
2. Optional checks without a debug session: `variables.sample` (sample count, ordered timestamps, plausible span, and optionally an increasing counter) and negative cases that must be rejected before any confirmation or hardware write (unknown symbol, read-only and out-of-bounds variables, a reused write confirmation, a flash request with a different ELF digest or without confirmation).
3. A debug round: `debug.start` to the entry breakpoint, step over/in/out, `debug.inspect` of stack, scopes and variables, paused read and write round trip, an optional function breakpoint (hit, then disabled and confirmed not to stop, then removed), continue, running read, a running write through managed sampling (aligned 32-bit, the target must keep running), pause, then the optional RTOS task snapshot and SVD peripheral read/write/rejection checks (after the firmware has run past its init code), restart to the entry breakpoint, and stop. `--repeat N` runs this round N times after a single flash to expose intermittent run-control failures.
4. Attach without reset: a marker value written before attaching must still be present afterwards; the original value is restored. Then `chip.read` and `fault.read` prove the probe was released and the firmware is still healthy.

**Every profile erases and programs its target**, so use dedicated boards. Peripheral writes and the variable writes change the running firmware's state briefly; choose targets that cannot actuate hardware.

`npm run test:hil:matrix` (Windows only) runs each profile on Windows, attaches the same probe to WSL2 with `usbipd attach --wsl`, repeats the profile under Linux with Xvfb, and always runs `usbipd detach` afterwards, including after a failure or Ctrl+C. Because `usbipd attach` needs a running distribution and WSL stops an idle one during the Windows runs, the matrix holds a WSL session open until it exits. The WSL run uses a mirror of this checkout under `$HOME/emberprobe-hil` (`--wsl-dir` overrides it), because the Windows `node_modules` holds Windows binaries; the mirror is refreshed and bundled on each matrix run and its `npm ci` is repeated only when `package-lock.json` changes.

### Configuration

Copy `test/hil/smoke.example.json` to `test/hil/smoke.local.json` (git-ignored) and edit it; `--config` or `EMBERPROBE_SMOKE_CONFIG` selects another file. `defaults` apply to every profile. Paths that differ between platforms are `{ "win32": ..., "linux": ... }` objects; a plain Windows `elf` path is read from WSL through `/mnt/<drive>`. Per profile:

- `name`: lowercase letters, digits and `-`; selects the profile with `--profile a,b`.
- `probe`, `target`: interface and target `.cfg` names, as in the sidebar; `transport`, `probeSerial`, `adapterSpeedKhz`, `rtos` as in the extension settings. Set `probeSerial` whenever two probes of one family are connected.
- `openocd`: OpenOCD executable; `toolchain`: ARM GNU `bin` directory containing `arm-none-eabi-gdb` and `arm-none-eabi-objdump`.
- `elf`: the board's smoke firmware. It is copied into the temporary workspace before the run.
- `variables.read`: globals that must read successfully; `variables.write`: one writable RAM scalar and a test value. The original value is read first and restored after the check.
- `debug`: `false` skips the debug-session steps.
- `svd`: the board's SVD file (same path rules as `elf`), required by `checks.peripherals`.
- `checks` (each entry optional; omit it to skip that check):
    - `sampling`: `{ "variable", "count" (2-1000, default 20), "intervalMs" (5-10000, default 50), "increasing" }`; set `increasing` only for a counter the firmware advances continuously.
    - `breakpoint`: a function the firmware calls repeatedly, such as a timer callback.
    - `rtosTasks`: FreeRTOS task names that must appear in the snapshot.
    - `peripherals`: `read` register paths; optional `write` `{ "target", "value" }` restored afterwards; optional `reject` entries `{ "target", "value", "code" }` that must fail with that error code. Do not configure writes to registers that drive actuators.
    - `negative`: `readOnly` (a const/Flash variable) and `outOfBounds` (an out-of-range array element) names that must be rejected.
- `usb.hardwareId` (`VID:PID`, for example `1366:0101` for J-Link) or `usb.busid` (from `usbipd list`): the probe handed to WSL. Use `busid` when two connected probes share a VID:PID.

Run `node scripts/hil-matrix.js --doctor` first. It checks the executables and ELF for each platform, the usbipd share state and the WSL tools, without opening a probe.

### One-time Windows/WSL setup

1. As administrator: `winget install --exact dorssel.usbipd-win`, then for each probe `usbipd bind --hardware-id <VID:PID>` (or `--busid`). Binding is persistent and does not change the Windows driver until the probe is attached to WSL.
2. In the WSL distribution: install Linux Node.js 20+ (nvm or NodeSource; Windows `node`/`npm` reached through interop are rejected), plus `rsync xvfb xauth usbutils` and the VS Code runtime libraries (`libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64`).
3. Install a Linux OpenOCD (xPack recommended, same version as Windows) and the ARM GNU toolchain, and point the profile's `linux` paths at them.
4. Install OpenOCD's udev rules (`60-openocd.rules` from the OpenOCD package's `contrib/`) into `/etc/udev/rules.d/`, then `sudo udevadm control --reload && sudo udevadm trigger`, so a non-root OpenOCD can open attached probes.
5. If Windows uses a localhost proxy, set `networkingMode=mirrored` in `%UserProfile%\.wslconfig` (or configure a proxy inside WSL); the first WSL run downloads npm packages and the VS Code test build. When WSL downloads stay slow, download the Linux test build on Windows instead (for example `curl.exe -L -o .vscode-test/vscode-linux-x64-1.136.1.tar.gz https://update.code.visualstudio.com/1.136.1/linux-x64/stable`); the matrix seeds the WSL cache from that archive.

### Running

```powershell
$env:EMBERPROBE_HIL_CONFIRM = 'YES'
npm run test:hil:matrix -- --profile h750-jlink,h750-cmsis-dap
npm run test:hil:matrix -- --platforms linux --profile f407-jlink
npm run test:hil:matrix -- --pause
npm run test:hil:matrix -- --repeat 5
```

`--pause` waits for Enter before each profile so the board or probe can be swapped. `--repeat N` (1-50) repeats the debug round. `--platforms win32` or `linux` runs one side; `--distro` selects a non-default WSL distribution; `--skip-bundle` reuses the existing Windows bundle. On a native Linux machine run `EMBERPROBE_HIL_CONFIRM=YES xvfb-run -a npm run test:hil:smoke -- --profile <name>` directly.

Each run writes `test-results/hil-smoke-<platform>-<profile>.json` with the duration, result and error of every step, and the matrix adds `test-results/hil-matrix.json`. A failed run-control step also records the debug state at that moment, and a failed profile keeps its VS Code logs (OpenOCD, GDB and adapter output) under `test-results/hil-logs/<platform>-<profile>/`. A failed step stops that profile; the runner then stops any remaining debug session. It does not retry, reset the target, change adapter speed or switch drivers.

WSL results establish Linux code paths (OpenOCD/GDB discovery, paths, permissions, debug and write flows), not native-Linux USB timing: USB/IP adds latency, so sampling-rate and timing comparisons still belong on a native Linux host. A probe that re-enumerates during a run (firmware update, CMSIS-DAP reboot) drops out of WSL and the Linux step fails; reattach and rerun rather than treating it as an extension failure.
