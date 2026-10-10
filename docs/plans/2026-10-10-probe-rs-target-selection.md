# Probe-rs MCU Target Selection Implementation Plan

**Goal:** Provide searchable probe-rs MCU targets and include target selection in one-click configuration.

**Architecture:** Query the configured executable with `probe-rs chip list`, parse its family/variant output, and reuse the resulting targets for manual selection and workspace detection. Match explicit chip names and STM32 part numbers only against that installed registry. Prompt for unresolved targets only during user-requested configuration, and recheck backend, executable, chip and connection ownership before saving.

**Tech Stack:** ES2022 CommonJS, Node.js `execFile`, VS Code Quick Pick and workspace settings, built-in `assert` tests.

### Task 1: Installed target registry

- Create `src/services/probeRsTargets.js` and `test/probe-rs-targets.test.js`.
- Parse family/variant blocks, retain family descriptions, deduplicate and validate names, and bound subprocess output and duration.
- Register the new normal test in `scripts/test-groups.js`.
- Validate success, malformed/empty output, missing executable, subprocess failure and resource limits without hardware.

### Task 2: Workspace target hints

- Extend `src/autoDetect.js` to inspect bounded `.ioc`, build/linker, Cargo and VS Code launch configuration files for probe-rs chip names.
- Match names against the installed registry; recognize STM32 packaging suffixes while preserving ambiguous candidates.
- Keep OpenOCD detection unchanged and avoid hardware access in probe-rs detection.
- Test exact matches, full part numbers, conflicting targets, unsupported chips and oversized files.

### Task 3: Manual and one-click selection

- Update `src/mainViewProvider.js` to show searchable chip/family Quick Pick entries and save `emberprobe.probeRsChip`.
- Include matched targets or interactive selection in forced one-click configuration; preserve existing settings and avoid prompts during background detection.
- Use probe-rs configuration completeness when deciding whether sidebar startup needs detection.
- Add Chinese/English UI messages and provider tests covering persistence, cancellation, failures and connection/configuration changes during asynchronous selection.

### Task 4: Documentation and verification

- Update `docs/PROBE-RS-EMBASSY.md` with manual and one-click configuration behavior.
- Run focused tests, `npm run check`, `npm run quality`, `npm run bundle`, and `npm run test:e2e`.
- Verify target parsing against the locally installed probe-rs registry, inspect the final diff, and record any unavailable platform or hardware validation.

### Validation completed

- Windows x64, Node.js 24.13.1: `npm run check` passed with 383 checks and no failures.
- `npm run quality` passed, including formatting, types and coordinator/safety gates. Overall coverage: 86.22% lines/statements, 91.68% functions and 83.57% branches; the new registry service has 100% line/function coverage and 96.77% branch coverage.
- `npm run bundle` and `npm run test:e2e` passed. VS Code 1.136.1 verified real Cargo/launch file searches, ambiguous hints, selected `.ioc` priority and existing probe-rs DAP ownership/read guards.
- Normal tests ran outside the managed Windows sandbox because its `realpath` and directory-link operations returned `EPERM`. Extension Host tests used `TEMP` and `TMP` pointing to the repository's `test-results/e2e-temp` directory to avoid system temporary-directory permissions.
- The installed probe-rs 0.32.0 registry returned 4,391 targets, including `STM32F407ZG` and `STM32H723VG`.
- No physical board tests were performed; Linux and macOS execution was not exercised.
