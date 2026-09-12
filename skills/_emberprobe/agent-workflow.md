# EmberProbe Agent Workflow (shared reference)

Shared operating rules for every EmberProbe MCU skill. Load this document only when the
current operation needs it — usually when a command fails, when a request spans several
skills, or when you are about to report a result. Skill-specific authorization prompts and
hardware constraints stay in each `SKILL.md`; this file covers the cross-skill contract only.

All EmberProbe skill scripts talk to the extension through a local Agent Bridge and report
failures as a single JSON `diagnostic` on stderr:

```json
{ "ok": false, "type": "diagnostic", "operation": "config.get",
  "error": { "code": "BRIDGE_TIMEOUT", "category": "extension", "stage": "request",
    "message": "...", "likelyCause": "...", "retryable": false,
    "suggestedActions": ["..."], "details": { "method": "config.get", "timeoutMs": 20000, "elapsedMs": 20001, "resultUnknown": true } } }
```

Always read `error.code`, `retryable`, and `details` before deciding what to do next. The
extension's own `likelyCause`/`suggestedActions` (when present) are more specific than any
generic guess and take priority.

## Failure handling

Follow this order for every failure. Do not skip steps and do not substitute a guess for evidence.

1. **Record** the operation, `error.code`, `error.stage`, and the relevant `details` (method,
   timeout budget, elapsed time, invalid targets, OpenOCD tail, etc.).
2. **Separate fact from assumption.** State what the diagnostic proves (e.g. "no response
   within the 20 s transport budget") apart from what it does not (e.g. the actual target state).
3. **Check the relevant state** with a read-only call before acting — for example `debug.status`
   after a control timeout, `config.get` after a config timeout, `peripherals.read` after a write.
4. **Retry only when allowed.** Retry is permitted only if a precondition changed or the
   diagnostic marks the operation `retryable` (see Retry policy). Never retry to "see if it works".

Never invent a root cause the diagnostic does not support. Do not claim a probe is busy, a
target is disconnected, an SVD caused a crash, or GDB is missing unless a specific code or
`details` field says so. An unavailable configuration or a missing detection tool is **not**
evidence that hardware is disconnected.

## Retry policy

- **Read-only calls** (`config.get`, `chip.read`, `fault.read`, `elf.analyze`, `peripherals.list`,
  `peripherals.read`, `debug.status`, `debug.breakpoints.list`, `variables.read`,
  `variables.sample`, `variables.exportCsv`): if preconditions are unchanged, retry **at most once**.
  If it fails again, stop and report the diagnostic.
- **State-changing calls** (`config.set`, `debug.start`, `debug.control`,
  `debug.breakpoints.update`, `peripherals.write`, `variables.write`, flash programming): a
  transport timeout means the **result is unknown** (`details.resultUnknown` is `true`). The
  request may have taken effect, not taken effect, or still be running. **Do not resend it
  automatically.** Query the matching read-only method to learn the real state, report it, and
  let the user decide. A timeout never means the request was cancelled.

## Cross-skill calls

- The debug probe has a **single owner**. Do not start a second OpenOCD-backed operation
  (flash, chip info, fault read, sampling) while another is running; `PROBE_BUSY` means wait or
  let the user stop the current owner — the skill never implicitly pauses or preempts.
- Route by need: configuration via `mcu-config`; STM32 `.ioc` changes and initialization generation via `mcu-cubemx`; firmware footprint via `mcu-elf-analyze`
  (static, no hardware, but still needs the Bridge to read the selected ELF); live identity via
  `mcu-chip-info`; crash diagnosis via `mcu-fault-analyzer`; variables via `mcu-variables`;
  registers via `mcu-peripheral-debug`; session control via `mcu-debug-control`; flashing via `mcu-flash`.
- Distinguish **no hardware dependency** from **no Bridge dependency**. Some reads need no probe
  (ELF analysis, `peripherals.list`, `config.get`) but every skill still needs the Bridge to be
  reachable; a Bridge failure is an extension/activation problem, not a wiring problem.

## Batch and verification requests

For "check everything" or multi-operation requests, first build an **operation coverage table**
listing each intended operation and its preconditions. Mark any operation whose preconditions are
missing as **blocked** rather than attempting it. Unless the user explicitly asked, do **not**
download resources, generate a test SVD, change settings, or start a debug session just to make a
check pass. Report which operations ran, which were blocked and why.

## Configuration changes

- Change **only the fields the user requested**. A read (`config.get`, `--get`, `--status`,
  `--list`) must never mutate configuration, bindings, or hardware.
- An explicit repair request may include the necessary changes, but state the evidence and the
  expected effect before applying them.
- For temporary changes made during a test, record the original state first, then restore and
  verify it within the authorized scope. Never leave a probe, session, or setting in a state the
  user did not approve.

## Reporting success and scope

Limit every conclusion to the operation that actually ran:

- A **status query** succeeding does not prove a **debug start** works.
- A **verify** succeeding does not prove a **program/flash** succeeded.
- A **session-gate** failure does not prove the **register-path preflight** is broken.
- **No fault flags** does not prove the **program is running correctly** — it only means no fault
  is currently pending.

Report the concrete evidence you observed (selected ELF and its SHA-256, resolved target/probe and
their `sources`, the DAP state event, the readback value), not an assumed outcome. If a flash or
verify preflight degraded, surface its `diagnostics` and the per-field `sources`
(`explicit` / `config` / `auto` / `default` / `none`) so the user can see where each value came from.
