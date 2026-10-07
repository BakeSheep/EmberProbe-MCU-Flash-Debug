# UI message repair plan

Repair the eight findings in `docs/UI-MESSAGES-AUDIT.md` without changing hardware authorization or ownership.

1. Keep successful command return values compatible, use null for cancellation and thrown errors for failure. Await file/config selection and all resulting saves before reporting completion. Keep a successful SVD binding clear distinguishable from cancellation.
2. Carry ELF warnings through metadata, completed types and failed parsing messages. Render bounded, text-only diagnostics in the sidebar and variable import dialog, independently of list filtering.
3. Add a visible RTOS status/error line. Retain historical snapshots, label them after execution or identity changes, and reject late responses by session, stop generation and inspection generation.
4. Convert exceptions to complete UI messages, including localization parameters and bounded diagnostics.
5. Distinguish GDB, Tcl, Telnet and unidentified binding failures; preserve execution errors when OpenOCD probing fails. Correct voltage and unsigned-helper wording.
6. Add focused production-path regressions, inspect rendered UI, then run check, quality, bundle and relevant Extension Host tests. Preserve all pre-existing CPU-related changes; do not run HIL or modify README.

Prefer these local changes over replacing all command APIs or only editing strings: local changes repair the confirmed failure paths while keeping existing callers and hardware boundaries intact.
