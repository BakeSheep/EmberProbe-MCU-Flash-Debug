# Probe Connections

[中文](probe-connections.md)

Plug in a probe, choose the debugger and target scripts, and you are ready. With one probe there is nothing to pick; with several, pick one in the sidebar. For J-Link driver issues, see [J-Link](jlink.en.md).

## Picking a probe

The **Connected probe** row below **Select debugger** lists every attached probe, whatever script is selected, and new devices appear on their own.

- **Check mark**: the device the next operation will use. Hover to see why: selected, only device, or chosen by target chip.
- **Click a device**: saves it as this workspace's probe. A device of another type also switches the debugger script to that type's default.
- **Refresh button**: checks immediately and reads the chip on each probe, showing its core (for example `Cortex-M4`) after the serial. The read never halts, resets or writes the target.
- **Not connected**: a saved device that was unplugged. No other device takes its place.
- **Disabled**: devices of one type with no reliable serial cannot be told apart. The reason is shown.

If an operation started from the UI cannot decide on a probe, this list opens; no prompt appears.

## Selection priority

1. An explicit serial (`--probe-serial` in standalone flash scripts).
2. A serial written in the debugger script.
3. The probe picked in the sidebar.
4. The only device present.
5. With several of one type, the target chip decides.

Your pick is saved per workspace on this machine and is not written to settings files.

## Telling probes apart by target chip

With no probe picked, EmberProbe follows the target chip rather than a particular probe: each operation reads the chip's identity first and compares it with the chip recorded for the workspace.

- If they differ, the operation stops before it starts and the sidebar shows both chips with **Use this chip**. Click it if you really changed boards.
- With several probes of one type, the one connected to the recorded chip is used.
- This check never halts, resets or writes the target.
- A probe you picked is used as is, with no check.

## Supported probes

| Probe | Notes |
| --- | --- |
| J-Link | See [J-Link](jlink.en.md) |
| CMSIS-DAP, ST-Link, XDS110, Nu-Link, TI-ICDI | Told apart by serial |
| FTDI, FT232R, VSLLINK | The debugger script sets the USB IDs; FTDI needs VID/PID in the script |
| KitProg | Cannot be selected by serial; connect only one at a time |
| Other OpenOCD adapters | Passed to OpenOCD as is |

## Network probes

CMSIS-DAP TCP and ST-Link TCP are configured in the debugger script. There is no settings panel for them.

CMSIS-DAP TCP needs an explicit backend and host; the default port is 4441:

```tcl
source [find interface/cmsis-dap.cfg]
cmsis-dap backend tcp
cmsis-dap tcp host probe.example
cmsis-dap tcp port 4441
```

ST-Link TCP connects to the local ST-Link server, `127.0.0.1:7184` by default. Change the port with `st-link backend tcp 7185`, or `hla stlink_backend tcp 7185` in HLA scripts.

## Probes without a serial

Probes with no reliable serial can still be inspected and read. With several attached, disconnect the others or write the real serial in the debugger script.

If the system cannot confirm such a probe's identity, firmware download, debug launches that download, halt, reset and memory writes are refused until the exact USB serial is configured. Attach without download still works.

Windows shows spaces in a serial as `_`, so the real serial `ATK 20190528` appears as `ATK_20190528`. Use the real value in scripts.

## Troubleshooting

| Message | Meaning and fix |
| --- | --- |
| `PROBE_SELECTION_REQUIRED` | Several probes and no way to decide; pick one in the sidebar list |
| `PROBE_TARGET_MISMATCH` | The connected chip differs from the record; check the board, then click **Use this chip** |
| `PROBE_IDENTITY_UNVERIFIED` | The probe's identity cannot be confirmed; write the real serial in the debugger script |
| `PROBE_BACKEND_AMBIGUOUS` | A TCP host is set but the backend is `auto`; add `cmsis-dap backend tcp` to the script |
| `PROBE_DRIVER_UNSUPPORTED` | A J-Link on Windows is using the SEGGER driver; see [J-Link](jlink.en.md) |
