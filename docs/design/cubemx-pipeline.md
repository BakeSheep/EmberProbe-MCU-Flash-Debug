# CubeMX generation design

User steps are in [CubeMX generation](../guide/agent/cubemx.en.md).

EmberProbe chooses the generator from the selected project file: `.ioc` uses STM32CubeMX, `.ioc2` uses STM32CubeMX2. There is no
setting for this choice. Both share the same safety pipeline: prepare a candidate, confirm it in
the Agent conversation, regenerate a baseline and a candidate in staging directories, refuse drift,
write back with a backup, record a manifest and offer `--check`.

## Tool discovery

`emberprobe.cubemx2Path` points to the CubeMX2 launcher, for example `stm32cubemx2-1.1.2.exe`, rather than the legacy
`STM32CubeMX.exe` or bundled Java. Discovery first reads ST's official external bundle registration:
`$CUBE_BUNDLE_PATH/.config/external_bundles.json`, or the default bundle root under
`%LOCALAPPDATA%/stm32cube/bundles` on Windows and `$XDG_DATA_HOME/stm32cube/bundles` on Linux
(`~/.local/share/stm32cube/bundles` when unset). It validates the registered `stm32cubemx-application` manifest and
resolves its matching standalone launcher. Multiple valid registered versions select the newest.

If no registered launcher is valid, it queries `cube --resolve --json mx`, using STM32Cube Core's bundled CLI when
that extension is installed, otherwise `cube` on PATH. This only resolves the official application bundle; it does
not execute `cube mx start`, launch CubeMX2 or install bundles. Missing tools and invalid/stale records fall back to
common installation directories, versioned directories and PATH, plus Windows desktop/Start menu shortcuts and
uninstall registry locations. Registry/manifest JSON reads are bounded to 2 MiB. Linux accepts
an executable `stm32cubemx2` or `stm32cubemx2-<version>` launcher; macOS detection is currently unavailable.

## Generation safety

EmberProbe regenerates a baseline and a candidate in separate staging directories before writing any project files. The stages are created under the system temporary directory (`emberprobe-cubemx-stage-*`), never inside the workspace, which also keeps CubeMX's deep `Drivers`/`Middlewares` paths short on Windows. They are removed when the operation ends; removal waits for confirmed CubeMX exit, and stages older than 24 hours left by a crashed extension host are swept when the next stage is created. For `ProjectManager.UnderRoot=false`, it places existing sources in the project-name child directory that CubeMX uses, so native Keep User Code processing can read them. Both stages must produce an expected `main.c`: a staged copy plus a generic `OK` is insufficient. CubeMX may preserve an unchanged file's timestamp, so an explicit generation record for that exact staged file is also accepted as evidence.

The baseline comparison preserves existing text line endings and recognizes equivalent `.mxproject` section/key order and known path separators. It does not ignore source whitespace generally, remove meaningful metadata changes, or weaken byte-exact workspace concurrency checks. C and C++ USER CODE blocks are checked before writeback.

Log completion/error state is tracked while reading stdout/stderr, independently of the retained diagnostic tail. Generation failures return the last 100 lines (up to 16 Ki characters), plus the first detected failure line when available. An unusually long individual line is rejected conservatively. A `KO` answer to `project generate` fails generation; `KO` from other script commands (for example `project path` on Linux) does not. CubeMX's online updater and home-page advertisement panel log network failures at ERROR level even in script mode. Records whose log4j source class is `WebUtils`, `HomeAdPanel` or an `*Updater*`/`*Advert*` class, plus the stack trace directly below them, are reported as warnings. Firmware package, migration and generation-failure messages still block regardless of their source, as do errors and exceptions from any other source.

Each operation has a diagnostics directory in extension storage (`diagnosticsPath`): CubeMX logs stream directly into it (`baseline.log`, `generating.log`, `deepCheck.log`), drift failures add `baseline-drift/`, and a writeback adds `backup/` with the original bytes of each modified or deleted file. The backup is written before the first project file and is what `recoveryRequired` recovery uses. The newest 20 directories per project are kept; directories of operations whose source state is `recoveryRequired` or `unknown`, and directories holding a `backup/` that a retained operation record still reports, are never pruned (the operation store keeps the latest 50 records). A successful generation result is not a compilation or hardware test.

The project snapshot skips version control, editor and agent tool directories (`.git`, `.agents`, `.claude`, `.vscode`, …). Links in CubeMX inputs and outputs (`Core`, `Drivers`, `Middlewares`, `cmake`, the `.ioc`, linker scripts, startup files and generated root build files) are rejected, because they could redirect writes or feed linked sources into Keep User Code. Other links are skipped, and generation is rejected with `linked_output_path` if regenerated output would be written on or below a skipped link.

Regression coverage is in `test/cubemx-generation-safety.test.js`, `test/cubemx-workspace-isolation.test.js` and `test/cubemx.test.js`; these tests require no CubeMX installation or hardware.

Cancellation before process startup creates no script if already cancelled, or waits for removal of the script created during cancellation before returning. Cancellation and timeouts after startup first terminate CubeMX, then escalate to SIGKILL. If exit still cannot be confirmed, `CUBEMX_EXIT_UNCONFIRMED` is returned while the project and staging files remain owned by that process. New generation/deep checks remain blocked. `cubemx.cancel` retries termination; ownership and deferred cleanup finish only after process exit.

`CUBEMX_BASELINE_DRIFT` can indicate a real conflict; `details.changes` and `details.baselineOutput` hold the evidence. EmberProbe does not silently relocate or discard such edits.

Agent generation is confirmed in the Agent conversation using the returned plan-bound
confirmation ID. The Agent shows the project and changes, waits for the human's answer,
then submits that ID. A 24-hour project permission requires an explicit chat choice and
`remember`; EmberProbe does not show a second operation approval dialog. Execution recomputes
the project identity and rejects a changed plan.

# CubeMX2 (.ioc2)

## Spike findings (Windows, CubeMX2 1.2.0, STM32C593RET6, 2026-11-03)

- **Install layout.** The application bundle is
  `<install>/resources/stm32cubemx-application/<version>/` with `CubeBundle.json`,
  `dist/stm32cubemx2.exe` (Electron backend, also the GUI), `dist/bin.js` (MX CLI) and a bundled
  Node under `bundles/node/<version>/node/bin/`. An install may hold several versions; the official
  registry `%LOCALAPPDATA%/stm32cube/bundles/.config/external_bundles.json` names the active one and
  the install root may only carry an older versioned launcher. `cube --resolve --json mx` returns
  `command: [<node>, <bin.js>]` (1.2.0) instead of the earlier `["cube", "node", <bin.js>]`.
- **Environment.** The backend needs the bundle's exported variables
  (`CUBE_MX2_INTERNAL_BUNDLES`, `CUBE_DCM`, `COOP_API_COMPATIBILITY`, from `CubeBundle.json` with
  `${CUBE_BUNDLE_ROOT}` substituted). `CMSIS_PACK_ROOT`, `CUBE_CACHE_PATH` and `CUBE_LOG_PATH`
  default correctly when unset; an incorrect value makes project loading fail with
  `ErrorClockDescriptor: File not found` and missing DMA/EXTI/NVIC descriptors.
- **Backend lifecycle.** `stm32cubemx2 --guiless --allow-multiple-windows --no-sandbox
  --backendTimeout=<ms>` prints `BACKEND_PORT <n>` on stdout after about 1.3 s and keeps running
  until shutdown or the timeout. It is a single-instance Electron application: a second start with
  the same user data directory exits with code 0 after about 0.4 s and hands over to the running
  instance (the GUI included). `--user-data-dir=<private dir>` gives a separate instance that runs
  beside any other one. The backend writes `%LOCALAPPDATA%/stm32cube/.metadata/
  stm32cubemx2-backend-<pid>.json` with its port, pids and an Electron security token; the CLI reads
  that token for `--port` calls. `bin.js shutdown --port <n>` kills both backend pids; no process is
  left and only a stale metadata file remains, which the CLI ignores.
- **CLI without `--port`.** It reuses any running backend found through that metadata, including a
  user's GUI, so EmberProbe always passes `--port` of the backend it owns.
- **CLI output.** One JSON document, `{ "status": "success", "data": ... }` with exit code 0, or
  `{ "status": "error", "errorMessage": "..." }` with exit code 1. The error document was seen on
  stdout as well as stderr, so both are parsed. Deprecation warnings may precede it.
- **Project file.** `.ioc2` is TOML: one `"File: <relative path>" = """<JSON or YAML>"""` entry per
  internal settings file (clock, DMA, NVIC, pinout, EXTI, peripherals, software configuration and
  composition, `*.csolution.yml`, `project/*.cproject.yml`, `project.cube`) and a final
  `["Project Description"]` table with `workingAreaId`, `version` and `mx2Version`. Loading a copied
  project rewrites `workingAreaId`; saving reorders the clock store, so diffs of saved files are
  noisy and are summarised by section.
- **Mutations.** `peripherals enable --peripheral USART1 --mode Async` changes the backend model
  only; the `.ioc2` changes after `project save` (pins PA10/PA15 with their alternate functions and
  `HAL_UART_PROJECT_USE_HAL` were added).
- **Generation.** `ide-project generate --format CMake --build-target ".debug_GCC+<CPN>"
  --destination <dir> --source include-packs-from-local` needs `--build-target`, `--destination`
  and `--source`; a non-empty destination additionally needs `--force`. It took 16 to 19 s and wrote
  about 28 MB without absolute paths. Two generations of the same project into different empty
  directories are identical except for the timestamp in `.settings/exported-files.json`.
- **Ownership instead of USER CODE markers.** Generated sources have no `USER CODE` blocks.
  `.settings/exported-files.json` lists every written file with a SHA-256 and a `fileGroup`:
  `generated` (HAL init code, CMake fragments), `project_file` (`CMakeLists.txt` files), `pack`
  (copied device and driver packs), `user_code` (`main.c`, `main.h`) and `RTE`
  (`user_modifiable/`: startup file, linker script, system file). With `--diff keep_user` CubeMX2
  keeps any file whose content differs from its recorded checksum, including edited generated files.

## EmberProbe rules derived from the spike

- EmberProbe starts its own backend for each operation with a private user data directory, talks to
  it only through `--port`, and stops it with `shutdown --port`, falling back to killing the process
  tree. It never attaches to an existing CubeMX2 instance.
- Generation always runs into empty staging directories, once for the current project (baseline) and
  once for the candidate. Writeback follows the file groups: `generated`, `project_file` and `pack`
  files are owned by CubeMX2 and must still equal the baseline in the workspace (otherwise the run
  stops with drift); `user_code` and `RTE` files are written only when absent from the workspace.
  The candidate `.ioc2` replaces the project file. The timestamp in `exported-files.json` is ignored
  when comparing.
- EmberProbe never installs or downloads packs; generation uses `include-packs-from-local`.

## Agent operations

Select the `.ioc2` as `iocPath` (the sidebar's project picker and `mcu-config --set "iocPath=..."`
accept `.ioc2`) and configure `emberprobe.cubemx2Path` in User settings. The project's recorded
CubeMX2 version (`mx2Version`) must be installed; EmberProbe picks the matching application bundle
under the launcher's `resources/stm32cubemx-application/` and does not migrate projects.

| Step | MCP tool | `mcu-cubemx` script |
| --- | --- | --- |
| Summary of chip, peripherals, pins, export settings | `cubemx_inspect` | `--inspect` (`--prefix` filters the internal files) |
| Read-only CubeMX2 commands | `cubemx_query` | `--query --operations '<json>'` or `--operations-file` |
| Change configuration on a staged copy | `cubemx_prepare` with `operations` | `--prepare --operations-file ops.json` |
| Generate after confirmation | `cubemx_start` / `cubemx_execute` with `candidateHash` | `--start --candidate-hash <hash> --confirm <id>` |
| Consistency check | `cubemx_check` | `--check [--deep]` |

An operation is `{ "command": "peripherals enable", "args": { "peripheral": "USART1", "mode": "Async" } }`.
Options are written without dashes; flags take `true`. EmberProbe adds the project path and backend
port itself, so `project-path`, `port` and `host` are rejected. Only allowlisted commands run
(`src/services/cubemx2Commands.js`): queries over peripherals, pinout, clock, NVIC, DMA, EXTI,
middleware, utilities, software configuration and build targets, and configuration changes for the
same areas. Creating or deleting projects, installing packs, enabling middleware components,
`generate` and `save` are not available as operations.

`cubemx_prepare` with operations copies the project to a staging directory under a new working area,
runs the operations in order, saves, reads `clock get-clock-status`, and stores the result as a
candidate in EmberProbe's extension storage (the newest 20 are kept). The workspace is not written.
The result lists each operation's output, the clock status, `candidateHash` and the semantic changes
grouped by clock, pins, NVIC, DMA, peripherals, middleware, export and other. A failing operation
fails the whole preparation; nothing is stored.

Generation then follows the shared pipeline with the CubeMX2 file-group rules above. Edited
`user_code`/`RTE` files (such as `main.c`) are kept and named in `warnings`; deep checks report them
as `userCodeChanges` with `user_modified`. Files the previous configuration generated but the new
one does not (for example a disabled peripheral's `mx_*.c`) are removed after the drift check proved
them unchanged. A backend that does not confirm its exit adds `CUBEMX2_EXIT_UNCONFIRMED` to
`warnings`, and its staged working areas are left in place.

Error codes specific to CubeMX2: `CUBEMX2_MISSING`, `CUBEMX2_BUNDLE_MISSING`,
`CUBEMX2_VERSION_MISMATCH`, `CUBEMX2_PROJECT_INVALID`, `CUBEMX2_PROJECT_REQUIRED` (a CubeMX2 tool on
an `.ioc` project), `CUBEMX2_OPERATION_INVALID`, `CUBEMX2_COMMAND_FAILED`, `CUBEMX2_PACK_MISSING`
(install the pack in the CubeMX2 UI), `CUBEMX2_BACKEND_FAILED`, `CUBEMX2_TIMEOUT`,
`CUBEMX2_OUTPUT_TOO_LARGE`, `CUBEMX2_BUILD_TARGET_MISSING` and `CUBEMX2_OUTPUT_INVALID`.

Not covered yet: sidebar UI for CubeMX2 configuration and pack status, creating projects, Linux
(the backend lifecycle was verified on Windows only), and building or flashing the generated project.
