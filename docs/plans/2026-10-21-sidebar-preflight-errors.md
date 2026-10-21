# Sidebar preflight error recovery

**Goal:** Missing configuration or a failed preflight must finish each sidebar action with an actionable status and release any acquired probe lease.

**Architecture:** Keep configuration and connection validation in the host services. Chip information requires a target and a resolvable probe, but does not require an ELF. Use the existing per-operation error messages rather than a UI timeout that could conceal an active hardware operation.

**Tech stack:** CommonJS JavaScript, Node assert, JSDOM and VS Code Extension Host tests.

## Audit and implementation

1. Exercise chip reads with an empty configuration, multiple probe families, a rejected executable lookup, a busy coordinator and a failed preflight. Add regressions to `test/chip-info-service.test.js` and `test/ui-messages.test.js`; verify failures before changing production code.
2. Move chip configuration, probe resolution and lease acquisition inside the service's error boundary. Validate the target before automatic probe discovery. Release the lease in one `finally` block and preserve Agent errors.
3. Add terminal chip status replies at the sidebar message boundary for early read/control exceptions. Keep SVD synchronization failures separate from the chip result.
4. Audit download, launch, attach, live sampling, CPU load, variables, memory, RTOS, SVD and peripheral actions. Add empty-configuration and failure/recovery checks to existing test suites where coverage is missing. Preserve automatic probe selection and operation-specific prerequisites.
5. Run affected tests, `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Verify the Linux UI against the updated bundle without connecting to a probe or running destructive HIL tests. Record results in the final response.

## Acceptance

- Empty configuration produces a terminal configuration error and an enabled chip-read button.
- Probe discovery and ownership failures cannot leave chip reads or controls spinning.
- Selecting a target and a unique probe permits a chip read with no ELF.
- Other sidebar actions either reject missing prerequisites or finish with their existing stopped/error state; failures do not start a probe session or retain ownership.

## Audit outcome and validation

| Operation | Prerequisites and failure handling |
| --- | --- |
| Chip information and chip control | Fixed exceptions escaping probe discovery, lease acquisition and the sidebar entry point. The sidebar receives `chipInfoStatus: error`; acquired ownership is released. ELF remains optional. |
| Download, launch and attach | Existing `executeCommand` error replies and `finally` cleanup recover correctly. Added empty-configuration and ambiguous-probe regressions through the host dispatcher and rendered sidebar. |
| Live sampling | Existing `liveStatus` error replies and startup-promise cleanup recover correctly; covered both missing configuration and failed probe discovery. |
| CPU load | ELF metadata is required; existing CPU safety tests reject missing ELF before creating a hardware worker and confirm lease release. |
| Variables and memory analysis | Existing live-error and memory-error replies handle missing or invalid ELF. Memory sidebar tests cover `ELF_NOT_CONFIGURED` and clear retained results. |
| RTOS and peripherals | Existing session/SVD guards and operation-specific error replies prevent an indefinite loading state. Inactive controls remain disabled without the required session or SVD. |
| Configuration pickers and official SVD | Existing cancellation/error replies finish pending actions. SVD synchronization errors now use `svdStatus`, preserving the completed chip result. |

Validation passed on Windows with Node 24: `npm run check` (414 entries), `npm run quality`, `npm run bundle` and the complete `npm run test:e2e`. Host runs used workspace temporary directories because sandbox/system-temp permissions initially blocked unrelated symlink and rename fixtures. The updated Linux development host was reloaded and checked visually: with no ELF or selected debugger, chip discovery reports an error and restores the read button. No probe was transferred to WSL and no firmware was programmed for this fix.
