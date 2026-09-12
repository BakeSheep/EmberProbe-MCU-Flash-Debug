# CubeMX generation and baseline conflicts

EmberProbe regenerates a baseline and a candidate in separate staging directories before writing any project files. For `ProjectManager.UnderRoot=false`, it places existing sources in the project-name child directory that CubeMX uses, so native Keep User Code processing can read them. Both stages must produce an expected `main.c`: a staged copy plus a generic `OK` is insufficient. CubeMX may preserve an unchanged file's timestamp, so an explicit generation record for that exact staged file is also accepted as evidence.

The baseline comparison preserves existing text line endings and recognizes equivalent `.mxproject` section/key order and known path separators. It does not ignore source whitespace generally, remove meaningful metadata changes, or weaken byte-exact workspace concurrency checks. C and C++ USER CODE blocks are checked before writeback.

`CUBEMX_BASELINE_DRIFT` can still indicate a real conflict. Inspect `details.changes` and the retained stage. For example, a manually added source in `cmake/stm32cubemx/CMakeLists.txt` can be deleted by CubeMX because that file is regenerated. Put user sources in the user-owned top-level CMake file instead:

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Src/stress_test.c
)
```

Remove the duplicate manual entry from the generated source list after reviewing the change, then prepare again. EmberProbe does not silently relocate or discard such edits.

Log completion/error state is tracked while reading stdout/stderr, independently of the retained diagnostic tail. Generation failures return the last 100 lines (up to 16 Ki characters), plus the first detected failure line when available. An unusually long individual line is rejected conservatively. Logs and files from successful generation stages remain in the retained stage for diagnosis. A successful generation result is not a compilation or hardware test.

Regression coverage is in `test/cubemx-generation-safety.test.js` and `test/cubemx.test.js`; these tests require no CubeMX installation or hardware.
