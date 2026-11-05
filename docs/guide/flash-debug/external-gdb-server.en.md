# External GDB Server

[中文](external-gdb-server.md)

Attach EmberProbe's debugger to a Cortex-M / ARM32 TCP GDB server that you started yourself. **This is experimental, off by default, and not validated against specific servers or boards.**

## Configuration

1. Enable it in VS Code settings for the target workspace or folder:

   ```json
   {
     "emberprobe.experimental.externalGdb.enabled": true,
     "emberprobe.experimental.externalGdb.target": "127.0.0.1:3333",
     "emberprobe.experimental.externalGdb.connectionMode": "extended-remote"
   }
   ```

   `target` is `host:port` or `[IPv6]:port`; serial, URL and pipe targets are not accepted. `connectionMode` is `remote` or `extended-remote`.

2. Add a `launch.json` entry:

   ```json
   {
     "name": "External GDB attach",
     "type": "emberprobe",
     "request": "attach",
     "servertype": "external",
     "executable": "${workspaceFolder}/build/app.elf"
   }
   ```

3. Start your GDB server, select this configuration in Run and Debug, and press F5.

You need a trusted workspace, a local ELF matching the target firmware, and a configured toolchain. Sidebar, Explorer and Agent debug commands keep using OpenOCD and ignore this switch.

## What works

- Breakpoints, call stack, variables, STL display, pause, continue and step.
- Paused memory reads, and variable reads and writes from the sidebar.

If the target is running at attach, it gets interrupted, so attaching may pause it.

RTOS threads come from the server. EmberProbe does not configure the server's RTOS.

## Ending and recovering

1. Stop debugging in VS Code. This only disconnects and exits the local GDB; the target's state depends on the server.
2. Stop the external server yourself and confirm it released the probe.
3. Turn off `emberprobe.experimental.externalGdb.enabled`.
4. Use sampling, flashing and other features by hand. They do not resume on their own.

After an external connection attempt, EmberProbe holds itself back from the probe to avoid competing, even across window reloads, until these steps are done. This protection covers only EmberProbe in this window, not other programs or windows.

## Limits

Download, automatic reset, Restart, multicore groups, running sampling and SWO/RTT are not supported, and neither is managing the server or drivers.

EmberProbe does not send OpenOCD `monitor` commands on its own. Attach hooks you configure still run, so check that your server supports them.

## Related documents

- [Debug session design (Chinese)](../../design/debug-sessions.md)
- [Debug toolchain](../getting-started/toolchain.en.md)
