# Writing variables

Use `scripts/write.js` from the Skill directory. Writing RAM changes firmware behavior immediately and uses a two-step authorization flow.

Submit only the intended write. With the sidebar full-access grant active, this command may execute immediately
and return `permission.mode: "full"`; otherwise it returns a confirmation plan when needed.
Never enable that grant yourself.

Submit the exact write:

```bash
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5
```

If confirmation is required, show every resolved variable, address, inferred type, current value, and requested value. Ask in the Agent conversation whether to allow only this write, allow it and trust future variable writes for the same ELF and connection in this workspace for 24 hours, or deny. Only after the answer, repeat the identical request with `--confirm <confirmationId>`; add `--remember` only for explicit workspace trust. EmberProbe does not display a second operation approval dialog.

```bash
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId>
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId> --remember
```

Use `--reset-permission` when the user asks to restore prompts. Confirmation IDs are bound to the ELF fingerprint and exact plan. Remembered permission is bound to the ELF SHA-256; rebuilding or switching the ELF requires confirmation again. Write plans and results include `firmwareConsistency`; while it is `mismatch` (the ELF differs from the image EmberProbe last programmed) a remembered permission does not apply and the plan carries an `ELF_TARGET_MISMATCH` warning. Show that warning to the user before asking for confirmation, because the addresses may not match the running firmware. Only scalar variables and scalar leaves such as `sensor.x` or `buf[0]` are writable, with type inferred from DWARF. A name defined in several compilation units (for example a `static` in two `.c` files) is rejected with `VARIABLE_AMBIGUOUS` and never written through the first match: confirm with the user which source file is meant, then request the write with that candidate's qualified name, such as `--set "other.c::g_cfg.mode=2"` (see "Same-named statics in several source files" in [reading.md](reading.md)). Show the qualified name and `sourceFile` in the confirmation summary. Flash, code, peripheral registers, ambiguous encodings, and composite ranges are rejected. Pointer storage (pointer variables and pointer members) is read-only. Write names are case-sensitive: a `VARIABLE_NOT_FOUND` whose `details.candidates` differ only in case must be confirmed with the user, never retried with the candidate on your own. One request writes at most 64 variables, and targets whose memory overlaps (union members, aliases) are rejected with `DUPLICATE_VARIABLE`; write them in separate requests. Values must be numbers or numeric strings; `null` or empty values are rejected with `INVALID_WRITE_VALUE`.

Typed dynamic scalar paths are also supported, for example `motor->motor_controller.speed_PID.Kp`,
`head->next->gain`, `values[2]` for a supported STL container, or `lookup[0].second` for a map value.
The host reads current pointer/container descriptors on demand, without requiring a prior sample. Raw pointers
need explicit `->` or `.value` dereferencing; pointer-to-array indexing uses its DWARF array bounds. A raw
`T *` does not establish a dynamic array length. No container insertion, deletion, resizing or function calls occur.
Const fields, map keys, set elements, container internals, bitfields, string storage and unknown types remain read-only.
Changing a pointer/container descriptor or the selected debug stop invalidates a pending confirmation; request a new
plan rather than substituting the new address into an old approval. `WRITE_TARGET_CHANGED` during execution carries
`details.written` and `writtenItems`; inspect current values before any retry. These checks cannot pin malloc objects,
detect all same-address reuse, or synchronize with firmware writers. The firmware must keep the object alive during
the operation; pause the relevant execution sources or use firmware-coordinated tuning when that cannot be ensured.

After execution, report previous, written, and read-back values plus `verified` and `halted`. Prefer exact text fields. A non-halting `WRITE_VERIFY_FAILED` may mean firmware immediately overwrote the value; do not retry blindly. `WRITE_READBACK_FAILED` means the write command ran but the value could not be read back: read the variable before deciding to retry. `DEBUG_STATE_CHANGED` from a running write carries `details.written` and `details.verified`; only retry without checking when `written` is `false`. Running managed OpenOCD debug sessions allow aligned 32-bit word writes when runtime sampling is ready; pause for other widths or unaligned writes. Standalone writes retain the appropriate running or halt/verify/resume transaction. Dynamic writes are not atomic across multiple fields and are never automatically retried or rolled back.
