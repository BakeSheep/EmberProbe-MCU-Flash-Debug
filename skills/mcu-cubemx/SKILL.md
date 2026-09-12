---
name: mcu-cubemx
description: Modify an existing STM32 .ioc configuration and regenerate initialization code with STM32CubeMX on Windows through EmberProbe. Use for pin, peripheral, clock or initialization changes and requested code regeneration.
---

# CubeMX initialization code

Requires Windows, the EmberProbe Agent Bridge, an existing configured `.ioc`, and the matching standalone CubeMX installation with its bundled Java and installed firmware package. No hardware is required.

Read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md) for failure handling and evidence boundaries.

Use `node <skill-dir>/scripts/cubemx.js --workspace <workspace> <operation>`:

1. `--detect` checks CubeMX. `--inspect` reads the selected project and its configuration. If no `.ioc` is selected, have the user select one or click Auto-detect Configuration under MCU configuration. The `mcu-config` skill can also select an existing workspace `iocPath`. The CubeMX executable is configured only through the extension UI or user settings.
2. Prepare the requested configuration in a separate candidate text file inside the selected project workspace. The Bridge reads this file by path, so large configurations do not exceed its request-body limit. Never edit the original `.ioc` directly. Preserve unrelated properties, chip, project name, toolchain, package and CubeMX versions. Resolve related pin, DMA, NVIC and clock settings from the existing project and appropriate device documentation; do not invent undocumented property values.
3. Run `--prepare --candidate <candidate-file>`. For regeneration without configuration changes, omit `--candidate`. Show the returned configuration changes, project path and generation scope to the user.
4. When `confirmationRequired` is true, ask whether to allow this operation once, allow this project for 24 hours, or deny. Only after the user's answer run `--execute --candidate <same-candidate-file> --confirm <confirmationId>`. Add `--remember` only for explicit 24-hour authorization. Never manufacture approval or reuse a consumed ID. If already trusted, execute without a confirmation ID. A changed plan requires fresh preparation. Denial ends the operation without executing.
5. The extension generates a baseline and candidate in isolated project copies, checks for existing hand edits and concurrent changes, then writes back with a recovery snapshot. On baseline drift, show the affected files and stop; inspect and migrate hand-written logic separately before retrying. Do not bypass the check or patch generated initialization code to suppress the error. Logs, differences and recovery copies are retained in the returned stage/backup directory; do not treat these copies as source projects.
6. Report the actual changed files and generation result. Run the project's existing documented build command when available. If no build entry exists, report “Generation completed; compilation not verified.” A failed build must be reported separately, without claiming generation proves compilation or hardware correctness.

Use `--permission` to inspect remembered authorization independently of generation validation. It returns the saved target and expiry; `applicability: unknown` and `trusted: false` mean the current target could not be verified, not that the saved record was deleted. Version mismatch alone does not block this query. Use `--reset-permission` to revoke authorization, and `--cancel` to cancel active CubeMX jobs. A notification in VS Code also provides cancellation. Do not automatically retry a timed-out or failed mutation.

To derive a candidate without editing the source, use:

```powershell
node <skill-dir>/scripts/cubemx.js --workspace <workspace> --generate-candidate --output candidate.ioc --changes '{"USART2.BaudRate":"115200"}'
```

`--changes` is a JSON object of decoded property names and string values; omit it to copy the configuration unchanged. The output must be a new file in the selected workspace with an existing parent directory. Existing output files are never overwritten. Unmodified text is preserved; changed properties are escaped and the command returns their differences. This checks Properties syntax only, not pin conflicts, clock validity or peripheral compatibility. Continue with `--prepare --candidate <returned-candidatePath>` and the normal authorization workflow. Creating a candidate does not authorize writing the source or generating code.

Initialization configuration belongs in `.ioc`; application logic belongs in separate `.c/.h` files. Put necessary calls inside preserved `USER CODE` blocks. Do not hand-edit CubeMX-owned regions. The first version does not migrate CubeMX versions, install packages, change chips/toolchains, or support external generation paths, links, hooks and custom templates.
