# DAPLink flash repairs Implementation Plan

> Execute the following tasks in this workspace, preserving the existing audit report and user changes.

**Goal:** Fix the four confirmed audit findings without removing RAM backup, retrying writes or changing reset policy.

**Architecture:** Keep selection, validation and OpenOCD argument construction in the shared skill modules. All managed
hardware entry points reuse exact serial identity and an explicit adapter-speed ceiling. Download operations retain their
lease until process close; diagnostics retain bounded output and the last flash stage.

**Tech Stack:** ES2022 CommonJS, Node assert fixtures, OpenOCD Tcl, Windows/Linux/macOS USB metadata.

## Tasks

1. Add failing regression coverage in `test/daplink-flash.test.js` and register in `scripts/test-groups.js`.
   Cover serial fidelity, multi-device/missing/unknown identity, composite USB grouping, reset-time speed changes,
   delayed process close, output limits, stage diagnostics and preserved work-area backup.
2. Extend `skills/_emberprobe/probe-connection.js`, `probe-inventory.js`, `probe-preflight.js` and
   `src/services/probeConnectionService.js`; update detection, configuration, authorization and CLI consumers.
   Keep J-Link numeric validation and driver rules; use exact bounded strings for CMSIS-DAP/ST-Link.
3. Extend shared `openocd-launch.js` to enforce an explicit speed ceiling across target events while retaining original
   event scripts. The zero/default setting retains script behavior. Test real generated Tcl with a mock adapter where available.
4. Fix `src/openocdRunner.js` completion ordering and enrich shared diagnostics/Agent execution with phase tracking.
   Do not automatically resend commands; retain bounded output and result-unknown status after timeout.
5. Update configuration descriptions and `docs/DAPLINK-FLASH-AUDIT.md`/connection documentation.
   Run affected tests, then `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`.
   Record toolchain and hardware validation limits. No HIL, driver switch, programming or publishing is authorized.

## Completion

Implemented all four findings, including shared module installation and family-aware configuration transactions.
Preserved work-area backup, original reset initialization and write authorization. Validation and environment details
are recorded in [the audit report](../DAPLINK-FLASH-AUDIT.md). Real-board validation remains unperformed.
