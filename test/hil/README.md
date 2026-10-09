# EmberProbe HIL runners

The independent [Embassy H723 smoke app](fixtures/embassy-h723/README.md)
exercises Rust global sampling, DAP tuning, and defmt RTT on a dedicated board.
Its opt-in probe-rs DAP acceptance script does not modify the main firmware
workspace. Build and flash that app before running the DAP-only script. The
separate VS Code Extension Host acceptance runner flashes the dedicated board
itself and checks EmberProbe's UI-side sampling and tuning pipeline.

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
