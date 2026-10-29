# GDB Warm-up Readiness Implementation Plan

**Goal:** Complete the warm-up of the actual Windows GDB before acquiring the probe, and make cold preparation visible.

**Architecture:** Keep the existing throwaway `--version` process. Start background preparation immediately for trusted workspaces with a selected ELF, resolve tools in the same order as a real launch without prompting, and await any remaining preparation before probe acquisition. Retain separate GDB processes and existing session ownership and cleanup.

**Tech Stack:** CommonJS, Node child processes, VS Code configuration, built-in assert, real ARM GDB with an in-memory RSP target.

## Evidence and choice

- In an isolated VS Code Extension Host, the first GDB start took 5446 ms and the second 46 ms.
- Explicitly awaiting the existing version warm-up took 5631 ms; the following first MI start took 48 ms.
- A persistent GDB broker adds process handover and cleanup complexity. Replacing version warm-up with MI warm-up is unnecessary for this reproduction. Complete and observe the existing preparation first.
- Clicking Debug before a genuinely cold GDB has prepared can still require the cold-start time. Moving that work into preparation does not itself reduce total time; early background preparation is the latency improvement.

## Tasks

1. Extend tool preflight tests for prompt-free Windows warm-up lookup: configured/saved/process PATH, refreshed system PATH, then ST discovery. Preserve synchronous background lookup callers and the Linux behavior.
2. Test immediate trusted/ELF-gated scheduling, rescheduling after GDB tool settings change, and a blocked warm-up that must complete before probe acquisition. Implement launch ordering without changing hardware commands.
3. Add a bounded, path-free warm-up snapshot and a `warmup` startup phase. Normalize trace metadata before the adapter prints it. Cover success, failure, reuse and pending preparation; never mark timed-out preparation successful.
4. Update `docs/FLASH-PERFORMANCE.md` and `docs/DEBUG-TOOLCHAIN.md` with scheduling, lookup and cold-start limits. Preserve README and unrelated sidebar CSS changes.
5. Run affected tests, `npm run check`, `npm run quality`, `npm run bundle`, relevant Extension Host tests and real-GDB image acceptance where available. Repeat the isolated no-hardware VS Code experiment with completed background preparation; do not reset or program the user's board.

## Validation result

The rebuilt extension automatically prepared GDB in the background in 5661 ms. Its first MI start then took 42 ms, the second 44 ms, and both reported `startup.warmup: 0`. Complete memory-target attach took 232/228 ms. This verifies the isolated host-side preparation path, not the latency of the user's full extension profile.

`npm run check` (484 files, no failures), `npm run quality`, `npm run bundle`, `npm run test:e2e` and `test/gdb/debug-images.test.js` with the installed ARM GNU toolchain passed on Windows. The normal and quality commands used Node 24.13.1. Sandbox child-process access errors were resolved by running build/Extension Host checks with normal permissions and keeping temporary data inside the workspace.

## Real workspace follow-up

The user subsequently installed the package and reported more than a minute from pressing F5 to `main`. In that session the handler-to-entry trace measured 11359 ms, `gdbStart` 5667 ms, and completed version preparation 5546 ms with zero remaining warm-up wait. Thus successful version preparation does not guarantee a fast MI start in this profile, and handler timestamps omit time queued before configuration resolution. Extension Host logs also recorded unresponsiveness and ST dependency activation during the wait.

With explicit user approval, temporarily disabled only the F407 workspace's STM32Cube Debug Core and its five dependents (Generic/Jlink/STlink GDB servers, registers, RTOS). CMake, Cube core/build tools and clangd stayed enabled. The previous workspace-disabled list was empty; the exact IDs and original state are recorded in `.vscode-test/f407-extension-comparison.json`.

After reloading, the user started the same diagnostic configuration and confirmed approximately 7–10 seconds from F5 to `main`. The trace measured 7017 ms total, including 5503 ms in `gdbStart`, 151 ms connecting and 437 ms for CRC; firmware matched and download was skipped. This is a workspace-level workaround for the minute-scale symptom. The remaining GDB initialization delay is unresolved. A second isolated run using the user's actual VS Code 1.144.0 also stayed fast (48/45 ms), as did a software-only adapter run with the actual adapter's environment (34 ms); neither reproduces that remaining full-profile delay.
