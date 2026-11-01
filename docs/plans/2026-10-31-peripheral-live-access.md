# Peripheral access without halting

Implement SVD-bound register and field reads/writes in standalone, running-debug and paused-debug modes.
Reuse the current probe owner's connection and never halt, reset or resume for peripheral access.
Keep paused DAP access for shared groups and external servers. Running Tcl access supports aligned
8/16/32-bit registers only; retain SVD side-effect and special-write restrictions.

1. Add bounded natural-width peripheral transactions to OpenOCD and Worker RPC.
2. Route SVD operations through an access service, reusing or temporarily leasing connections.
3. Bind write approval to the SVD, physical connection and debug generation, and check original values.
4. Enable sidebar, skill and MCP access; invalidate stale responses and distinguish readback differences.
5. Test state/width/authorization/concurrency boundaries; run check, quality, bundle and E2E.

No hardware writes, HIL, programming, driver changes or releases are authorized.

## Implementation validation

Validated on Windows x64 with Node 24.13.1:

- npm run check: 484 syntax/test files checked, zero failures.
- npm run quality: ESLint, Prettier, type checking, global coverage and individual service gates passed.
- npm run bundle: passed.
- Extension Host E2E: all suites passed using cached VS Code 1.136.1 and this worktree's built extension.
  The sandboxed Electron host could not write below the managed worktree or the default system temp path,
  so the runner used independent profiles, a copied workspace fixture and TEMP/TMP/TMPDIR below the original
  checkout's ignored .vscode-test directory. Test code and extension source were unchanged by that adaptation.
- Real renderer browser previews: standalone, debug-running and debug-paused captured and visually inspected.
- Artifacts: test-results/peripheral-access/ contains screenshots and the Extension Host log.

No real-board reads/writes or HIL were performed. Multicore running access and running 64-bit transfers
remain unsupported as planned; paused access remains available.

## Board follow-up — 2026-11-01

After separate user authorization, APM32F407 + J-Link/WinUSB passed three-state peripheral reads and six
same-value writes. Command-name discovery and unrelated-configuration invalidation were corrected based on
the real-board findings. See [the acceptance record](../validation/peripheral-board-2026-11-01.md) for evidence,
exact scope and limitations. The preceding validation section describes the earlier software-only run.
