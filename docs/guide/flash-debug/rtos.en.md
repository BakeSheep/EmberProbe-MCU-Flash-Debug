# RTOS Debugging

[中文](rtos.md)

When on, the VS Code call stack shows RTOS tasks, and you can switch between tasks to see each one's stack and locals. It is off by default.

FreeRTOS also has an experimental task panel for viewing the task list while paused. It has no board acceptance yet.

## Turning it on

Set `emberprobe.rtos` in VS Code settings, or per session in `launch.json`:

```json
{
  "type": "emberprobe",
  "request": "launch",
  "executable": "${workspaceFolder}/build/app.elf",
  "rtos": "FreeRTOS"
}
```

`attach` configurations work too. `launch.json` wins, and `"rtos": ""` turns it off for that session only.

Values: `FreeRTOS`, `ThreadX`, `chibios`, `Chromium-EC`, `eCos`, `embKernel`, `linux`, `mqx`, `nuttx`, `RIOT`, `uCOS-III`, `Zephyr`, `auto`, `none`.

- Names are case-sensitive; `freertos` is an error.
- Prefer naming the RTOS. `auto` can guess wrong on stripped or heavily optimized firmware.
- `none` explicitly turns it off, overriding any RTOS set in a target script.

Changes apply at the next debug start. VS Code's Restart keeps the old value, so stop and start again.

## What changes while debugging

- The call stack lists every task. Before the scheduler starts you see one thread, which is normal.
- Viewing another task's stack does not affect stepping; a step acts on the task you requested.
- A task that has exited reports `DEBUG_TASK_EXITED` rather than acting on another task.

## FreeRTOS task panel

Shows the task list while paused, with filtering and sorting. Older data is marked stale after you resume.

- Supports little-endian ARM32 and single-core FreeRTOS only, not FreeRTOS SMP.
- At the first stop in `main`, tasks usually do not exist yet and the panel says so. Run past initialization and pause again.
- Stack and runtime statistics depend on firmware configuration and are hidden when the fields are absent.
- Stack fill is an estimate, not the live stack pointer.

## Firmware requirements

Tasks are found through kernel symbols in the ELF, so the firmware must keep them.

The most common problem is `uxTopUsedPriority` being removed by the linker, which leaves no tasks found. Keep that symbol if this happens.

Whether the call stack shows task names or `Thread N` depends on what can be read from the firmware.

## Limits

- Only applies while debugging. Live sampling does not read RTOS structures.
- On dual-core parts only the current core is configured, so choose the core that actually runs the RTOS. See [Multicore debugging](multicore.en.md).
- Crashed-task analysis is not available.

## Troubleshooting

**`OPENOCD_RTOS_INVALID`**: the name or its case is wrong, or the target script has no current target.

**No tasks appear**: check that the scheduler has started, then whether `uxTopUsedPriority` was optimized out.

## Related documents

- [Debug session design (Chinese)](../../design/debug-sessions.md)
- [GDB console](gdb-console.en.md)
