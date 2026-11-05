# CubeMX generation and baseline conflicts

## Installation paths

Configure **EmberProbe: Cubemx Path** (`emberprobe.cubemxPath`) and **EmberProbe: Cubemx2 Path**
(`emberprobe.cubemx2Path`) in VS Code **User settings**. Both have `machine` scope and are shared by all workspaces
on this machine; they are no longer sidebar configuration entries. Existing saved values are preserved. Leave a
setting empty for automatic discovery, which saves the result to User settings and never replaces a saved path.
Invalid saved paths are reported with instructions to update the relevant setting. The sidebar keeps the workspace's
`.ioc` selection and firmware status.

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

The selected project file chooses the tool: `.ioc` projects use `emberprobe.cubemxPath`, and `.ioc2` projects use
`emberprobe.cubemx2Path` for inspection, CLI queries, configuration changes and generation (see
[CUBEMX2-GENERATION.md](../../design/cubemx-pipeline.md)). Firmware package checks in the sidebar apply to `.ioc` projects only.
Agent configuration reads include both paths, but Agents cannot change either executable path.

## Generation safety

EmberProbe regenerates a baseline and a candidate in separate staging directories before writing any project files. The stages are created under the system temporary directory (`emberprobe-cubemx-stage-*`), never inside the workspace, which also keeps CubeMX's deep `Drivers`/`Middlewares` paths short on Windows. They are removed when the operation ends; removal waits for confirmed CubeMX exit, and stages older than 24 hours left by a crashed extension host are swept when the next stage is created. For `ProjectManager.UnderRoot=false`, it places existing sources in the project-name child directory that CubeMX uses, so native Keep User Code processing can read them. Both stages must produce an expected `main.c`: a staged copy plus a generic `OK` is insufficient. CubeMX may preserve an unchanged file's timestamp, so an explicit generation record for that exact staged file is also accepted as evidence.

The baseline comparison preserves existing text line endings and recognizes equivalent `.mxproject` section/key order and known path separators. It does not ignore source whitespace generally, remove meaningful metadata changes, or weaken byte-exact workspace concurrency checks. C and C++ USER CODE blocks are checked before writeback.

`CUBEMX_BASELINE_DRIFT` can still indicate a real conflict. Inspect `details.changes` and compare the files with CubeMX's regenerated versions under `details.baselineOutput`. For example, a manually added source in `cmake/stm32cubemx/CMakeLists.txt` can be deleted by CubeMX because that file is regenerated. Put user sources in the user-owned top-level CMake file instead:

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Src/stress_test.c
)
```

Remove the duplicate manual entry from the generated source list after reviewing the change, then prepare again. EmberProbe does not silently relocate or discard such edits.

Log completion/error state is tracked while reading stdout/stderr, independently of the retained diagnostic tail. Generation failures return the last 100 lines (up to 16 Ki characters), plus the first detected failure line when available. An unusually long individual line is rejected conservatively. A `KO` answer to `project generate` fails generation; `KO` from other script commands (for example `project path` on Linux) does not. CubeMX's online updater and home-page advertisement panel log network failures at ERROR level even in script mode. Records whose log4j source class is `WebUtils`, `HomeAdPanel` or an `*Updater*`/`*Advert*` class, plus the stack trace directly below them, are reported as warnings. Firmware package, migration and generation-failure messages still block regardless of their source, as do errors and exceptions from any other source.

Each operation has a diagnostics directory in extension storage (`diagnosticsPath`): CubeMX logs stream directly into it (`baseline.log`, `generating.log`, `deepCheck.log`), drift failures add `baseline-drift/`, and a writeback adds `backup/` with the original bytes of each modified or deleted file. The backup is written before the first project file and is what `recoveryRequired` recovery uses. The newest 20 directories per project are kept; directories of operations whose source state is `recoveryRequired` or `unknown`, and directories holding a `backup/` that a retained operation record still reports, are never pruned (the operation store keeps the latest 50 records). A successful generation result is not a compilation or hardware test.

The project snapshot skips version control, editor and agent tool directories (`.git`, `.agents`, `.claude`, `.vscode`, …). Links in CubeMX inputs and outputs (`Core`, `Drivers`, `Middlewares`, `cmake`, the `.ioc`, linker scripts, startup files and generated root build files) are rejected, because they could redirect writes or feed linked sources into Keep User Code. Other links are skipped, and generation is rejected with `linked_output_path` if regenerated output would be written on or below a skipped link.

Regression coverage is in `test/cubemx-generation-safety.test.js`, `test/cubemx-workspace-isolation.test.js` and `test/cubemx.test.js`; these tests require no CubeMX installation or hardware.

Agent generation is confirmed in the Agent conversation using the returned plan-bound
confirmation ID. The Agent shows the project and changes, waits for the human's answer,
then submits that ID. A 24-hour project permission requires an explicit chat choice and
`remember`; EmberProbe does not show a second operation approval dialog. Execution recomputes
the project identity and rejects a changed plan.

Cancellation before process startup creates no script if already cancelled, or waits for removal of the script created during cancellation before returning. Cancellation and timeouts after startup first terminate CubeMX, then escalate to SIGKILL. If exit still cannot be confirmed, `CUBEMX_EXIT_UNCONFIRMED` is returned while the project and staging files remain owned by that process. New generation/deep checks remain blocked. `cubemx.cancel` retries termination; ownership and deferred cleanup finish only after process exit.
