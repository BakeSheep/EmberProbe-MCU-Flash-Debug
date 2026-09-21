# J-Link optimization acceptance record

Scope: the approved OpenOCD-based compatibility improvement. No native SEGGER backend, USB driver replacement, concurrent ownership with Ozone, or full multi-root session model is introduced.

## Requirement evidence

| Requirement | Implementation and evidence |
| --- | --- |
| Physical identity and OS-only inventory | `probe-inventory.js`; Windows composite-parent grouping, Linux sysfs and macOS JSON fixtures in `probe-connection.test.js`. Missing serials remain unknown. |
| Explicit J-Link SWD/JTAG; no silent device fallback | `probe-connection.js`, `probeConnectionService.js`; tests cover required transport, manual/unique selection, duplicates, missing selected device, cancellation and Agent calls without UI prompts. |
| Serial and speed across all operations | Shared `buildOpenOcdConfigArgs`; `openocd-entrypoints.test.js` checks interface → serial → transport → target → speed for flash, chip/fault queries, standalone and managed sessions. Flash CLI and HIL share the preflight/argument contract. |
| Capability inspection without automatic initialization | `probe-preflight.js` queries compiled adapters and evaluates the selected interface with `noinit`, without loading a target. The executable capability cache is keyed by path, mtime and size. Bundled OpenOCD was queried locally and returned `jlink`; no target initialization occurred. Custom interface scripts remain trusted user code. |
| Settings and Agent/CLI surface | Workspace `probeSerial` / `adapterSpeedKhz`, `probe.list`, `mcu-config --probes`, flash `--probe-serial` / `--adapter-speed-khz`; invalid numeric/command-injection values are tested. |
| Stable sessions and configuration changes | Each prepared session records a settings snapshot. Configuration changes mark it stale for writes; ordinary reads retain the existing session. UI/Agent connection changes are rejected while persistent sessions are active. |
| Confirmation and saved trust bind the connection | Flash identity includes serial/speed and the resolved executable. Memory plans include connection identity; external DAP includes session ID/workspace. `write-connection.test.js` checks changed probes, stale sessions, old trust invalidation and DAP session switching. |
| Native errors, voltage and worker preservation | `jlink-diagnostics.test.js` covers native J-Link strings, USB errors, VTarget, hardware/firmware parsing, real MessageChannel error/event transport and redaction. Bridge, worker and UI share bounded error serialization. |
| Visible and copyable diagnostics | Sidebar connection settings, active connection/stale status and expandable diagnostic panel; `webview.test.js` verifies safe text rendering and copying. [Screenshot](images/jlink-connection-diagnostic.png) uses a simulated error, not a hardware result. |
| HIL cannot pass on shutdown alone | HIL uses production preflight and requires `EP_HIL_VERIFY_OK` after programming/verification. `hil-runner.test.js` rejects shutdown-only and “not verified” output. Workflow variables and dedicated-board procedure are documented. |
| User and Agent documentation | Both READMEs link `JLINK-COMPATIBILITY.md`; `mcu-config` and `mcu-flash` instructions describe the new parameters and failure handling. |

## Verification boundary

Final software gates on 2026-09-21:

- `npm run check`: 212 files checked, zero failures.
- `npm run quality`: ESLint, Prettier, JavaScript type checking and coverage gates passed; 88 normal test files passed. Coverage: 85.38% lines/statements, 89.52% functions, 76.73% branches.
- `npm run bundle`: passed, including the final bundle invoked by `test:e2e`.
- `npm run test:e2e`: passed activation, settings, packaged worker, secured sidebar/live-watch Webviews, simulated F5/DAP and packaged adapter checks. The final subsequent source change was a Prettier-only line wrap; type checking and coverage passed after it.
- `git diff --check`: passed. The screenshot was rendered with headless Edge and visually inspected; it is explicitly a UI fixture.

The local sandbox denied esbuild's parent-directory metadata access and headless browser startup. Approved local runs outside that sandbox completed the build, isolated Extension Host tests and screenshot rendering. No release, tag or remote push was performed.

Local environment: Windows x64, Node.js 24.13.1, VS Code Extension Host 1.136.1. Linux/macOS enumeration and diagnostic behavior are fixture-tested; those operating systems were not executed locally.

Bundled OpenOCD software probe: xPack OpenOCD 0.12.0+dev-02228-ge5888bda3-dirty (2025-10-04). The noinit adapter list and selected interface both resolve J-Link. This does not establish USB/firmware compatibility for a physical probe.

No hardware was initialized, flashed, reset or reconfigured. V9 JLinkOB, other OB implementations, V10/BASE devices and Ozone interoperability remain **hardware-unverified**. The exact-device matrix and evidence fields are in [the audit](JLINK-AUDIT-2026-09-20.md) and [HIL procedure](../test/hil/README.md). Software delivery does not depend on inventing hardware results.

## Historical baseline

The previous 2026-09-17 compatibility work fixed ELF drive-casing identity, USB error classification, numeric voltage parsing and shared transport/path resolution. Its documented baseline was 196 checks, 84.80% line coverage, successful bundle/E2E, with hardware still unverified. This change extends that work to physical serial selection and connection-bound authorization; it does not retract those path fixes or certify previously untested hardware.
