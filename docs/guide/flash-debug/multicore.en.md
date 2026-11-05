# Multicore Debugging

[中文](multicore.md)

Debug several cores of one chip with one OpenOCD and one probe, using a debug session per core. **This is experimental and has no dual-core board acceptance yet.**

## Configuration

First choose the probe, a dual-core target script and OpenOCD in EmberProbe. Then add one `launch.json` entry per core. Replace the ELF paths and check the indexes against the actual `target names` order:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "CPU 0 launch",
      "type": "emberprobe",
      "request": "launch",
      "executable": "${workspaceFolder}/build/core0.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 0,
      "rtos": "FreeRTOS",
      "runToEntryPoint": "main"
    },
    {
      "name": "CPU 1 attach",
      "type": "emberprobe",
      "request": "attach",
      "executable": "${workspaceFolder}/build/core1.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 1,
      "rtos": "FreeRTOS"
    }
  ]
}
```

| Field | Requirement |
| --- | --- |
| `serverGroup` | Group name: 1–64 letters, digits, underscores, dots or hyphens, starting with a letter or digit |
| `numberOfProcessors` | 2–32 |
| `targetProcessor` | Zero-based core index |
| `targetName` | Optional; must match the actual target name at that index |

## Startup order

1. Start the first core and wait for it to finish initializing.
2. Start the other cores. Their firmware must already be in place: joining a group only attaches, with no download or reset.

Starting configurations at once (compound) is not supported; joining during initialization returns `DEBUG_GROUP_BUSY`. The first core's `launch` resets and downloads by default, which may affect the whole chip.

## Switching cores

With several sessions running, choose one above the RTOS panel. This choice also decides which core receives sidebar paused reads, peripheral operations and Agent control.

Variables and the task table are read again after switching. You cannot switch during a write or execution control.

Sidebar variables use the selected ELF, which must match the current core's firmware. If not, select the matching ELF and retry.

Agents list candidates with `debug.status` and choose with `debug.select`:

```text
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --group dual --core 1
```

## Ending

Stopping one core leaves the others running. OpenOCD stops and the probe is released only when the last core exits.

## Limits

- Group members must share the probe, OpenOCD, target script, transport, speed, core count and RTOS setting. Each core can use its own ELF.
- Different RTOSes on different cores are not supported.
- Restart is not available in a group. End all sessions and start again.
- Groups cannot sample while running, and variables and peripherals are only accessible while paused.
- Synchronized cross-core stepping and consistent multicore snapshots are not promised.

## Related documents

- [Debug session design (Chinese)](../../design/debug-sessions.md)
- [RTOS debugging](rtos.en.md)
