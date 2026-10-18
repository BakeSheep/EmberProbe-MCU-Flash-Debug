# CubeMX generation and baseline conflicts

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

Each operation has a diagnostics directory in extension storage (`diagnosticsPath`): CubeMX logs stream directly into it (`baseline.log`, `generating.log`, `deepCheck.log`), drift failures add `baseline-drift/`, and a writeback adds `backup/` with the original bytes of each modified or deleted file. The backup is written before the first project file and is what `recoveryRequired` recovery uses. The newest 20 directories per project are kept; directories of operations whose source state is `recoveryRequired` or `unknown` are never pruned. A successful generation result is not a compilation or hardware test.

The project snapshot skips version control, editor and agent tool directories (`.git`, `.agents`, `.claude`, `.vscode`, …). Links in CubeMX inputs and outputs (`Core`, `Drivers`, `Middlewares`, `cmake`, the `.ioc`, linker scripts, startup files and generated root build files) are rejected, because they could redirect writes or feed linked sources into Keep User Code. Other links are skipped, and generation is rejected with `linked_output_path` if regenerated output would be written on or below a skipped link.

Regression coverage is in `test/cubemx-generation-safety.test.js`, `test/cubemx-workspace-isolation.test.js` and `test/cubemx.test.js`; these tests require no CubeMX installation or hardware.

Agent generation is confirmed in the Agent conversation using the returned plan-bound
confirmation ID. The Agent shows the project and changes, waits for the human's answer,
then submits that ID. A 24-hour project permission requires an explicit chat choice and
`remember`; EmberProbe does not show a second operation approval dialog. Execution recomputes
the project identity and rejects a changed plan.

Cancellation and timeouts first terminate CubeMX, then escalate to SIGKILL. If exit still cannot be confirmed, `CUBEMX_EXIT_UNCONFIRMED` is returned while the project and staging files remain owned by that process. New generation/deep checks remain blocked. `cubemx.cancel` retries termination; ownership and deferred cleanup finish only after process exit.
