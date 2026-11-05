# GDB Console

[中文](gdb-console.md)

In an EmberProbe debug session, every entry in the VS Code **Debug Console** is one GDB command.

## Common commands

| Input | Purpose |
| --- | --- |
| `bt` | Show the call stack |
| `info registers` | Show registers |
| `p counter` | Print a variable |
| `x/16wx 0x20000000` | Show 16 memory units as 32-bit hex |
| `set variable counter = 5` | Change a variable |
| `thread 2`, `frame 1` | Switch thread or frame |
| `continue`, `next`, `step`, `finish` | Run or step |
| `info breakpoints` | List all breakpoints and their actual state |

To print a variable, write `p counter`; typing `counter` alone does not evaluate it. Watch and hover still take expressions, so `counter` works there.

## Rules

- One line at a time, up to 16,384 characters. Interactive follow-up input is not supported. For multi-line commands, put them in a file and load it with `source`.
- Commands can be sent while the target runs; GDB decides whether they can execute. EmberProbe does not pause or resume for you.
- While a command runs, sidebar reads, writes and session switching wait. Stop always works.
- After a command, the call stack, variables and RTOS task table are read again and older results are marked stale.
- A command error only appears in the console and the session stays usable. A timeout or GDB exit ends the session with no automatic retry.
- In multicore debugging, the session selector at the top of the console decides which core gets the command. Chip-level actions in target scripts can still affect other cores.

## Breakpoints

- Breakpoints created with `break` belong to GDB and do not appear in the VS Code breakpoint list.
- Existing VS Code breakpoints stay in sync when GDB changes or deletes them.
- GDB's `enable` and `disable` cannot update the VS Code checkbox. Trust `info breakpoints`.

## Limits

- Raw GDB/MI commands are not supported.
- Agents cannot send arbitrary GDB commands here, and Agent write and flash confirmation is unaffected.

## Related documents

- [Debug session design (Chinese)](../../design/debug-sessions.md)
