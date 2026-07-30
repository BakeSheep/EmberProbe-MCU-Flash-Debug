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
- `EMBERPROBE_HIL_ELF`: absolute path to the board's dedicated smoke-test ELF.

Use dedicated, non-production boards. The workflow requires `EMBERPROBE_HIL_CONFIRM=YES`, verifies the ELF after programming, resets the target, records its SHA-256 fingerprint, and enforces a two-minute timeout.
