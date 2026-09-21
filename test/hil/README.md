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
