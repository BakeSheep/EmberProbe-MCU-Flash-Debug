---
name: mcu-cubemx
description: Modify an existing STM32 .ioc configuration and regenerate initialization code with STM32CubeMX on Windows through EmberProbe. Use for pin, peripheral, clock or initialization changes and requested code regeneration.
---

# CubeMX initialization code

Requires Windows, the EmberProbe Agent Bridge, an existing configured `.ioc`, and the matching standalone CubeMX installation with its bundled Java and installed firmware package. No hardware is required.

Use `mcu-config` to select `iocPath`. CubeMX executable paths are read-only through the Bridge. Firmware package status is derived by the sidebar from the MCU target and optional IOC; it is not a writable `config.set` field, and `--inspect` does not verify package installation. For missing packages, use the sidebar's native interactive firmware installer; the Bridge generation workflow does not install packages or change the IOC's package version.

Read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md) for failure handling and evidence boundaries.

Use `node <skill-dir>/scripts/cubemx.js --workspace <workspace> <operation>`:

1. `--detect` checks CubeMX. `--inspect` reads the selected project and its configuration (returns a compact summary by default; use `--prefix <prefix>` to filter properties, or `--full` for full raw properties). If no `.ioc` is selected, have the user select one or click Auto-detect Configuration under MCU configuration. The `mcu-config` skill can also select an existing workspace `iocPath`. The CubeMX executable is configured only through the extension UI or user settings.
2. Prepare the requested configuration in a separate candidate text file inside the selected project workspace. The Bridge reads this file by path, so large configurations do not exceed its request-body limit. Never edit the original `.ioc` directly. Preserve unrelated properties, chip, project name, toolchain, package and CubeMX versions. Resolve related pin, DMA, NVIC and clock settings from the existing project and appropriate device documentation; do not invent undocumented property values.
3. Run `--prepare --candidate <candidate-file>`. For regeneration without configuration changes, omit `--candidate`. `--prepare` returns a categorized summary of changes (at most 20 shown, full diff saved to disk) and verification status. Show the returned configuration changes, project path and generation scope to the user.
4. When `confirmationRequired` is true, ask whether to allow this operation once, allow this project for 24 hours, or deny. Only after the user's answer run `--start --candidate <same-candidate-file> --confirm <confirmationId>` (or `--execute`). Add `--remember` only for explicit 24-hour authorization. Never manufacture approval or reuse a consumed ID. If already trusted, run without a confirmation ID. A changed plan requires fresh preparation. Denial ends the operation without executing.
5. With `--start`, monitor progress using `--status --operation-id <operationId>`. If a network/bridge timeout occurs, query `--status` first. Re-running the exact same `--start` command is also safe: the CLI persists a request ID for 15 minutes, and the service returns the original operation instead of generating again. Never re-execute with a new request ID while an operation may still be running. The extension generates a baseline and candidate in isolated project copies, checks for existing hand edits and concurrent changes, then writes back with a recovery snapshot. On baseline drift, show the affected files and stop; inspect and migrate hand-written logic separately before retrying. Do not bypass the check, delete diagnostic logs, or patch generated initialization code to suppress the error.
6. Report the actual changed files and generation result. If generation failed, leave the task as uncompleted; you may write independent application logic, but do not claim CubeMX succeeded. Run the project's existing documented build command when available. If no build entry exists, report “Generation completed; compilation not verified.” A failed build must be reported separately, without claiming generation proves compilation or hardware correctness.

Use `--check` for quick consistency checking against the last committed generation manifest (verifying IOC and source modifications without running CubeMX; it works even when CubeMX is not installed). Use `--check --deep` to run an explicit isolated regeneration check. The deep check runs in the background and reports `staleCandidates`: files inside generation-owned directories that a fresh regeneration no longer produces (for example leftovers after removing a peripheral); this list is informational and does not by itself make the project inconsistent. Both report clear evidence boundaries without mutating the source project: quick check proves changes relative to the recorded manifest only, deep check proves regenerability under the current tools, and neither proves build or hardware behavior.

Use `--permission` to inspect remembered authorization independently of generation validation. It returns the saved target and expiry; `applicability: unknown` and `trusted: false` mean the current target could not be verified, not that the saved record was deleted. Version mismatch alone does not block this query. Use `--reset-permission` to revoke authorization, and `--cancel` (optionally with `--operation-id`) to cancel active CubeMX jobs. A notification in VS Code also provides cancellation. Do not automatically retry a timed-out or failed mutation.

To derive a candidate without editing the source, use:

```powershell
node <skill-dir>/scripts/cubemx.js --workspace <workspace> --generate-candidate --output candidate.ioc --changes '{"USART2.BaudRate":"115200"}'
# Or using a workspace changes file:
node <skill-dir>/scripts/cubemx.js --workspace <workspace> --generate-candidate --output candidate.ioc --changes-file changes.json
```

`--changes` is a JSON object of decoded property names and string values; `--changes-file` points to a workspace JSON file. They are mutually exclusive. Use `--deletions '["Mcu.IP1", "Mcu.Pin2"]'` to explicitly delete removed properties and prevent orphaned indices. The output must be a new file in the selected workspace with an existing parent directory. Existing output files are never overwritten. Unmodified text is preserved; changed properties are escaped and the command returns their differences. This checks Properties syntax and structural declarations (contiguous IP/Pin indices and unique members), not pin conflicts, clock validity or peripheral compatibility. Continue with `--prepare --candidate <returned-candidatePath>` and the normal authorization workflow. Creating a candidate does not authorize writing the source or generating code.

Initialization configuration belongs in `.ioc`; application logic belongs in separate `.c/.h` files. Put necessary calls inside preserved `USER CODE` blocks. Do not hand-edit CubeMX-owned regions. The first version does not migrate CubeMX versions, install packages, change chips/toolchains, or support external generation paths, links, hooks and custom templates.
