# MC02 Embassy hardware regression

The local `../emberprobe-mc02-regression` Git repository contains an independent
Embassy firmware and an automated VS Code Extension Host test for DM-MC02 /
STM32H723VG. It does not use the application's async task locals. Its complete
test instructions are in that repository's `README.md`.

The firmware keeps `TICKS`, `TUNE_MS`, `APPLIED_MS`, `GAIN`, `APPLIED_GAIN`,
`OUTPUT` and `GUARD_WORD` in ordinary global RAM. Only on-chip clocks and TIM5
are initialized. The test leaves D-Cache disabled to make debug-port RAM reads
consistent with the core's accesses.

The acceptance performs these steps through the production extension:

1. Check the probe-rs environment with the OpenOCD path deliberately unavailable.
2. Read H723 device identity, flash the independent firmware and resolve Rust
   globals, `Atomic<u32>` wrappers and `f32` DWARF types.
3. Start LiveWatch without a pre-existing debug session and verify that it
   creates an attach session without reprogramming.
4. Record changing global values, reuse the DAP connection for chip information,
   and check the real chart-history Worker's viewport.
5. Write `TUNE_MS` from 100 to 250 to 50 to 100 ms and `GAIN` from 1.0 to 2.5 to
   1.0. Each write needs exact read-back and firmware `APPLIED_*` acknowledgement.
   The task count must grow faster at 50 ms than at 250 ms; the guard word must
   remain unchanged.
6. Stop and reconnect automatic LiveWatch, transition to explicit attach with
   defmt RTT, and verify that stopping sampling keeps a user debug session.
7. Disconnect, replay hardware captures through the actual chart renderer and
   verify normalized curve geometry, the history viewport and chart freezing.

The graph backend now sends `chartValues` for current readings while the Worker
holds full history. Both HIL recorders accept this event and retain its origin
when normalizing captures for renderer replay.

Example local run after `npm ci` and `npm run bundle` in the extension repository:

```bash
cd ../emberprobe-mc02-regression
EMBERPROBE_HIL_CONFIRM=YES \
EMBERPROBE_HIL_PROBE=faed:4873-0:d5381744 \
EMBERPROBE_E2E_VSCODE_PATH=/usr/share/code/code \
node scripts/run-regression.cjs
```

This command flashes the board. Each run saves independent JSON, CSV, RTT and
SVG evidence under `reports/`; `reports/latest.json` points at the current run.
The accepted 2026-10-09 evidence is retained in `reports/accepted-2026-10-09/`.
Reports bind the result to the board UID, probe selector, toolchain versions,
ELF digest and extension bundle digest. Linux hardware acceptance does not
establish Windows or macOS hardware behaviour.

The real BMI088/VQF follow-up, its rates, parameter-write verification and
captured curves are recorded in [MC02 probe-rs validation](MC02-PROBE-RS-VALIDATION.md).
