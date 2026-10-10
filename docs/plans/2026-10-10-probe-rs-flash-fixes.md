# probe-rs flash audit fixes

**Goal:** Resolve the five actionable findings in the 2026-10-10 flash audit without accessing hardware.

**Design:** Use one `probe-rs download --verify --reset --binary-format elf` process against the existing digest-bound private ELF snapshot. Stream bounded CLI lines into the existing progress channel, retain the last reported stage and output tail, and mark interrupted or failed writes as potentially unknown. A zero exit status confirms the complete requested sequence; console stage labels alone do not establish success.

The provider must check workspace trust, CPU/probe/driver ownership and debugger state before stopping sampling and again before execution. Capture the automatic watch adapter before termination, wait for Bridge detachment and physical process exit, then acquire the download lease. Preserve the lease through process completion and ELF refresh. Share the successful-download refresh and sampling-restart handling with OpenOCD, respecting any newer user stop request. F5 launches default to write verification while preserving an explicit override; attach continues to disable flashing.

**Alternatives:** Keeping separate download/reset processes preserves the extra reconnect and partial-result problem. A new native flashing transport would greatly expand the change and hardware validation requirements. The existing CLI provides the needed verification/reset sequence in one session.

**Scope:** Fix verification, teardown waiting, download gates, post-flash refresh/restoration and diagnostics. Agent Flash remains explicitly unsupported for probe-rs; additional binary formats and transport UI are separate features.

**Implementation sequence:**

1. Add hardware-independent flash service regressions for snapshot identity/cleanup, required flags, one process, verification/reset failures, bounded progress, timeout and failed spawn.
2. Add provider regressions for delayed adapter exit, retained ownership on timeout, legacy live-session teardown, driver/session/CPU gates, rechecks after asynchronous work, successful refresh and restoration, and refresh/reconnect failure isolation.
3. Update the CLI service and launch verification defaults, then route both sidebar backends through common post-download helpers.
4. Update usage documentation and mark the audit report as describing the pre-fix baseline, preserving other work in progress.
5. Run focused regressions, `npm run check`, `npm run quality`, `npm run bundle` and the simulated Extension Host suite. Record unavailable checks and keep real-board validation separate.

**Constraints:** Retain existing uncommitted changes, Bridge/session isolation and coordinator leases. No README edits, commits, hardware flashing, reset, driver changes, HIL or release publishing are part of this request.
