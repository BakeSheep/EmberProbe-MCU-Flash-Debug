# Paused C/C++ inspection

Use `scripts/inspect.js` in `mcu-debug-control` for a paused native EmberProbe session.
This reads GDB/DAP's actual frame and object layout, including locals, globals, file statics,
registers, classes, bases and supported STL. It does not use running ELF RAM sampling.

```bash
node <skill-dir>/scripts/inspect.js --workspace <workspace> --threads
node <skill-dir>/scripts/inspect.js --workspace <workspace> --stack --thread 1 --start 0 --count 20
node <skill-dir>/scripts/inspect.js --workspace <workspace> --scopes --frame <returned-frame-handle>
node <skill-dir>/scripts/inspect.js --workspace <workspace> --variables --reference <scope-reference> --count 50
node <skill-dir>/scripts/inspect.js --workspace <workspace> --variables --reference <child-reference> --filter indexed --start 50 --count 50
```

Select an explicit session/core with `debug.js --select` if status is ambiguous. Use the
current thread list, then the selected task's frames; never assume thread 1 is the intended
RTOS task. Source lines are one-based, paging starts are zero-based, counts are 1–100.
Pass opaque `frame` and `reference` handles exactly as returned. Child `reference: null`
means no expansion. Do not pass DAP integer IDs or reuse a handle after the returned
`sessionId`/`stopEpoch`/`inspectionEpoch` changes. Resume, step, write and core switches invalidate handles;
on `DEBUG_INSPECTION_STALE`, restart from threads/stack/scopes.

Report `value` text without converting it to JavaScript Number (64-bit integers may exceed
its exact range). Preserve type, evaluateName, memoryReference, presentation hints and
unavailable/optimized-out diagnostics. Expand only relevant branches, respecting the
adapter's named/indexed counts; a page is not the whole container. Display names are not
stable symbol identities, and `evaluateName` is not permission to execute an expression.

The session's `prettyPrintingMode`/`emberprobe.prettyPrintingMode` chooses `builtin` (default,
no Python), `gdb` (only explicitly configured `prettyPrinterFiles`) or `raw`. Do not download
printers, enable scripts or change the mode merely to read an object. Legacy
`enablePrettyPrinting=false` selects raw only when a newer mode was not explicitly set;
`prettyPrinterPath` is deprecated and ignored. Unsupported built-in ABI/layouts fall back to
physical fields; that is not evidence of firmware corruption. Virtual bases and dynamic
types use paused GDB. The separate live runtime reader supports only its validated DWARF
layouts and memory ranges; it does not provide task/frame-local context. Built-in STL targets
libstdc++ layouts; libc++, the old string ABI, debug STL and fancy pointers need raw fields
or user-configured GDB printers. String summaries may be truncated; inspect child pages.

The Agent inspection API intentionally exposes only threads, stackTrace, scopes and variables.
Arbitrary expression evaluation, function calls and DAP setVariable/setExpression are not
part of this skill interface. Existing `mcu-variables` writes retain their RAM-leaf validation
and fresh confirmation; an object's expandable DAP presentation does not make it writable
through that API. Use `mcu-rtos` for FreeRTOS task metadata and stack fill estimates.
