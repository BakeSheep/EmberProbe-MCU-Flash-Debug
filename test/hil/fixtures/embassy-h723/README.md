# Embassy H723 smoke app

This independent app targets the STM32H723VGTx. It uses only on-chip resources
and exposes three `AtomicU32` globals for probe-rs LiveWatch tests:

- `TICKS`: changes continuously, suitable for a waveform.
- `TUNE_MS`: adjustable period, clamped by the firmware to 20–1000 ms.
- `APPLIED_MS`: period currently used by the async task.

Build without touching another firmware workspace:

```sh
cd test/hil/fixtures/embassy-h723
CARGO_TARGET_DIR=/tmp/emberprobe-h723-target cargo build --release --offline --locked
```

The ELF is `/tmp/emberprobe-h723-target/thumbv7em-none-eabihf/release/emberprobe-embassy-h723-smoke`.
The crate deliberately has no Cargo runner. Flash it only on a dedicated board
after the probe passes a read-only connection check. The host can read `TICKS`
and `APPLIED_MS` without changing firmware state. A probe-rs DAP `attach`
briefly halts the core during initialization before resuming.

## Manual VS Code test

1. Open the EmberProbe extension repository in VS Code. Press F5 and choose
   `EmberProbe: H723 smoke extension host`. Its prelaunch task bundles the
   extension and opens this smoke app in a second window.
2. In the second window, use the EmberProbe sidebar to select the ELF above
   through **Browse for ELF**. This folder's `.vscode/settings.json` selects
   probe-rs and the H723 chip. Set `emberprobe.probeRsPath` if `probe-rs` is
   not on VS Code's PATH.
3. Add `TICKS`, `TUNE_MS`, and `APPLIED_MS` to LiveWatch, and `TUNE_MS` to the
   write list. Start sampling and open the graph to see `TICKS` rise. Enter
   `250` for `TUNE_MS`, confirm `APPLIED_MS` becomes `250`, then restore `100`.
4. Stop the automatically created LiveWatch attach session. Press F5 in the
   second window to start `H723 smoke: attach + RTT`; start LiveWatch again
   against that debug session. Open the `EmberProbe RTT 0` Output channel to
   see periodic defmt logs.

After flashing and resetting the dedicated board, run the opt-in DAP acceptance
script from the EmberProbe repository root. It checks a changing waveform,
sets `TUNE_MS` to 250, observes `APPLIED_MS`, restores 100, and checks RTT:

```sh
EMBERPROBE_HIL_CONFIRM=YES \
EMBERPROBE_HIL_ELF=/tmp/emberprobe-h723-target/thumbv7em-none-eabihf/release/emberprobe-embassy-h723-smoke \
node test/hil/probe-rs-h723-smoke.js
```

To exercise the actual VS Code extension's probe-rs flash, LiveWatch, write
and RTT integration instead, run this opt-in Extension Host test from the
repository root. This runner flashes and resets the dedicated board:

```sh
EMBERPROBE_HIL_CONFIRM=YES \
EMBERPROBE_HIL_ELF=/tmp/emberprobe-h723-target/thumbv7em-none-eabihf/release/emberprobe-embassy-h723-smoke \
EMBERPROBE_E2E_VSCODE_PATH=/usr/share/code/code \
node test/hil/vscode-probe-rs/run.js
```
