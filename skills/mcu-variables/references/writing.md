# Writing variables

Use `scripts/write.js` from the Skill directory. Writing RAM changes firmware behavior immediately and uses a two-step authorization flow.

Start by requesting the exact write plan:

```bash
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5
```

If confirmation is required, show every resolved variable, address, inferred type, current value, and requested value. Ask in the Agent conversation whether to allow only this write, allow it and trust future variable writes for the same ELF and connection in this workspace for 24 hours, or deny. Only after the answer, repeat the identical request with `--confirm <confirmationId>`; add `--remember` only for explicit workspace trust. EmberProbe does not display a second operation approval dialog.

```bash
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId>
node <skill-dir>/scripts/write.js --workspace <workspace> --set kp=0.5 --confirm <confirmationId> --remember
```

Use `--reset-permission` when the user asks to restore prompts. Confirmation IDs are bound to the ELF fingerprint and exact plan. Remembered permission is bound to the ELF SHA-256; rebuilding or switching the ELF requires confirmation again. Only scalar variables and scalar leaves such as `sensor.x` or `buf[0]` are writable, with type inferred from DWARF. Flash, code, peripheral registers, ambiguous encodings, and composite ranges are rejected.

After execution, report previous, written, and read-back values plus `verified` and `halted`. Prefer exact text fields. A non-halting `WRITE_VERIFY_FAILED` may mean firmware immediately overwrote the value; do not retry blindly. Running managed OpenOCD debug sessions allow aligned 32-bit word writes when runtime sampling is ready; pause for other widths or unaligned writes. Standalone writes retain the appropriate running or halt/verify/resume transaction.
