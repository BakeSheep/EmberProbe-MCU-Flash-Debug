# probe-rs audit fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the five PR #25 findings and verify non-flashing attach and variable reads with the existing F407_car firmware.

**Architecture:** Validate sidebar/Agent variable reads at the shared DAP Bridge boundary. Bind the selected ELF to the active probe-rs core image, including write execution. Own the stdio adapter process so native F5 and sidebar launches acquire the same coordinator lease before spawning, and release it only after confirmed process exit. Restore per-session readiness when selecting a session. Read chip information through the selected adapter using its resolved launch settings.

**Tech Stack:** ES2022 CommonJS, Node.js 20+, VS Code debug adapter API, probe-rs DAP, built-in assert tests, VS Code Extension Host tests.

---

### Task 1: Regressions and common DAP read/write guards

- Add `test/probe-rs-safety.test.js` and register it in `scripts/test-groups.js`.
- Cover mismatched `coreConfigs[].programBinary`, runtime MMIO/out-of-section reads, valid RAM reads, session selection, and stale results.
- Extend `src/services/debugSessionBridge.js` with a shared read-plan validation callback and restore `probeRsReady` on selection.
- Extend `src/mainViewProvider.js` ELF guards to probe-rs and repeat identity validation before each memory transaction.
- Run the focused tests before and after the fixes.

### Task 2: Physical ownership for every startup route

- Add `src/services/probeRsDebugAdapter.js` and `test/probe-rs-debug-adapter.test.js`.
- Acquire `debugStart` before spawning, transition to `debugServer` on successful attach/launch, retain the lease until process close, and clean up spawn failure, cancellation, startup timeout, and shutdown.
- Integrate the owned adapter with `src/extension.js` and the provider. Use the same preparation checks for native F5, sidebar debugging, and automatic LiveWatch attach.
- Exercise contention, cleanup, protocol forwarding, and unconfirmed-exit behavior without a probe.

### Task 3: Session-bound chip information

- Use the active session's chip, probe, protocol, speed, and cwd for DAP chip reads; use workspace settings only for standalone reads.
- Share the existing debug lease for DAP reads and reject concurrent chip reads and stale session results.
- Extend the focused tests for empty/different workspace chip settings and session changes during a read.

### Task 4: Software validation

- Run affected tests, `npm run check`, `npm run quality`, `npm run bundle`, and relevant Extension Host tests.
- Preserve existing user work and keep generated outputs untracked.
- Record unavailable checks and fix regressions caused by the change.

### Task 5: F407_car hardware validation

- User confirmed the battery and encoders are disconnected. Keep the motor enable and tuning values unchanged.
- Inspect the existing Debug ELF and actual APM32F407ZG target/probe identity. Confirm probe-rs compatibility before claiming hardware support.
- Add an opt-in non-flashing Extension Host harness using an isolated workspace/profile and the existing ELF; do not edit the user's project settings or firmware.
- Verify actual RAM samples, chip information with the chip supplied only in the launch config, ownership contention, ELF mismatch rejection, and runtime MMIO rejection.
- Stop the adapter and confirm process/probe release. Document the tools, target, firmware identity, observations, and validation limits under `docs/`.
