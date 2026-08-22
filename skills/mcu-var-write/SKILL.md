---
name: mcu-var-write
description: Write new values into MCU global variables in RAM while firmware is running, through EmberProbe's OpenOCD Tcl-RPC service. The first write requires explicit confirmation in chat; the user may allow one write or trust future writes in the current workspace. Use when the user asks an agent to set, change, tune, override, or force a live embedded variable value.
---

# MCU Variable Write

Use `scripts/write-var.js` from this skill directory.

## This is a high-risk operation

Writing a live variable changes firmware behavior immediately. EmberProbe enforces a two-step chat authorization flow:

- Run the normal `--set` command first. If the workspace is not trusted, it returns `confirmationRequired: true`, a one-time `confirmationId`, and the exact variables, addresses, types, and values. **No memory is written yet.**
- Show that summary in chat and ask exactly one question: whether to **allow only this write**, **allow and stop asking for future writes in this workspace**, or **deny**.
- Only after an explicit user reply, rerun the identical `--set` command with `--confirm <confirmationId>`. Add `--remember` only when the user chose future writes without reminders.
- Never infer approval from the original write request. Never add `--confirm` or `--remember` before receiving the user's answer to the confirmation question.
- Workspace trust is persistent but limited to the current VS Code workspace. Use `--reset-permission` when the user asks to restore confirmation prompts.
- Only addresses inside the ELF's writable RAM sections (`.data`/`.bss`) can be written. Flash, code, and peripheral registers are rejected with `WRITE_NOT_ALLOWED`.
- Scalar writes require an unambiguous type from DWARF. EmberProbe never guesses a write encoding from symbol size; stripped ELFs are rejected with `WRITE_TYPE_UNKNOWN`.
- The confirmation ID is bound to the ELF fingerprint and exact write plan. If either changes, the request is rejected and must be reviewed again.

## Usage

```bash
node <skill-dir>/scripts/write-var.js --workspace <workspace> --set kp=0.5
# After the user chooses "only this write":
node <skill-dir>/scripts/write-var.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId>
# After the user chooses "do not ask again in this workspace":
node <skill-dir>/scripts/write-var.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId> --remember
# Restore chat confirmation for this workspace:
node <skill-dir>/scripts/write-var.js --workspace <workspace> --reset-permission
```

- `--set` takes `name=value` pairs separated by commas. Values may be integers or decimals; the type (`u8/i8/u16/i16/u32/i32/f32`) is inferred from the ELF's DWARF info and range-checked.
- Only scalar variables and single scalar leaves of structs/arrays (`sensor.x`, `buf[0]`) are supported. Whole structs or array ranges cannot be written (`UNSUPPORTED_VARIABLE`).
- If live sampling is active, EmberProbe reuses that connection; otherwise it starts a temporary probe session, writes once, and releases it.

## Result

Before authorization, the script prints a confirmation JSON object and performs no write. After authorization, `results` contains per-variable `previous`, `written`, `readBack`, and `verified`; `permission.mode` is `once` or `workspace`. Report the previous → written transition for each variable. `verified: true` means the value was read back byte-identical right after the write.

`WRITE_VERIFY_FAILED` usually means the firmware immediately overwrote the variable (e.g. it is recomputed every loop); explain that to the user instead of retrying blindly.

## Failure diagnostics

On failure, parse the single JSON `diagnostic` object on stderr (`error.code`, `likelyCause`, `suggestedActions`). Distinguish `WRITE_CONFIRMATION_INVALID` (expired, reused, or changed request), `WRITE_NOT_ALLOWED` (target not in RAM), `WRITE_TYPE_UNKNOWN` (no reliable DWARF type), `ELF_CHANGED_DURING_WRITE_CONFIRMATION` (ELF changed after confirmation was requested), `INVALID_WRITE_VALUE`, `VARIABLE_NOT_FOUND`, `PROBE_BUSY`, and `TARGET_NOT_CONNECTED`.
