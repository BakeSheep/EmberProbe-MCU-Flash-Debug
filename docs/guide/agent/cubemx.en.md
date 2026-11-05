# CubeMX Generation

[中文](cubemx.md)

Have an Agent change a CubeMX configuration and generate code, using the STM32CubeMX or STM32CubeMX2 installed on your machine. Changes are checked first and never silently overwrite your edits.

## Tool paths

Set these in VS Code **User settings**, shared by all workspaces on this machine:

| Setting | Tool |
| --- | --- |
| `emberprobe.cubemxPath` | STM32CubeMX, for `.ioc` projects |
| `emberprobe.cubemx2Path` | STM32CubeMX2 launcher (such as `stm32cubemx2-1.1.2.exe`), for `.ioc2` projects |

Leave them empty for automatic discovery, which saves the result to User settings and never replaces a saved path. Agents can read both paths but cannot change them.

CubeMX2 discovery covers Windows and Linux; macOS is not supported yet.

## Choosing a project

Select an `.ioc` or `.ioc2` file in the sidebar. The file decides which tool runs; there is no setting for this. The sidebar's firmware package check applies to `.ioc` projects only.

## How generation works

1. Ask the Agent for a change. This happens on a temporary copy, with no workspace writes.
2. The Agent shows the project and changes and waits for your answer in the conversation.
3. EmberProbe regenerates both the current and new configurations, compares them, then writes to the project.
4. Files being changed are backed up first.

You can choose to remember your answer for 24 hours; see [Agent permissions](permissions.en.md).

For the operations available to Agents, see the `mcu-cubemx` skill and [MCP tools](mcp.en.md#tools).

## Your code

**`.ioc` projects**: code inside `USER CODE` blocks is kept.

**`.ioc2` projects**: generated sources have no `USER CODE` blocks. `main.c`, `main.h`, the startup file, linker script and similar files are yours. Existing ones are not overwritten, only listed in `warnings`. Other generated files belong to CubeMX2, and editing them counts as a conflict.

## Resolving conflicts

`CUBEMX_BASELINE_DRIFT` means a generated file in the project differs from what the tool regenerates. Read `details.changes` and compare with the regenerated versions under `details.baselineOutput`.

A common case: a source file was added by hand to `cmake/stm32cubemx/CMakeLists.txt`, which is generated. Move it to your own top-level CMake file:

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Src/stress_test.c
)
```

Then remove the manual entry from the generated list and prepare again. EmberProbe does not move or discard such edits for you.

## CubeMX2 requirements

- The CubeMX2 version recorded in the project (`mx2Version`) must be installed. EmberProbe does not migrate projects.
- Install required packs in the CubeMX2 UI. EmberProbe downloads nothing, and a missing pack reports `CUBEMX2_PACK_MISSING`.
- Agents cannot create or delete projects, install packs or enable middleware components.
- So far it has been verified on Windows only, and there is no sidebar configuration UI.

## Limits

- A successful generation is not proof that the project compiles or works on hardware.
- Generation is refused when symbolic links in the project touch CubeMX inputs or outputs.
- Each operation's logs and backup are kept in extension storage; `diagnosticsPath` in the result gives the location.

## Troubleshooting

**A writeback was interrupted and the result shows `recoveryRequired`**: the backup is in `backup/` under `diagnosticsPath`.

**`CUBEMX_EXIT_UNCONFIRMED`**: the tool did not confirm its exit, which blocks new generation. Retry stopping it with `cubemx.cancel`.

**`CUBEMX2_VERSION_MISMATCH`**: install the CubeMX2 version the project records.

## Related documents

- [CubeMX generation design](../../design/cubemx-pipeline.md)
- [Agent permissions](permissions.en.md)
