# Verifying existing Flash

Use `scripts/verify.js` from the Skill directory. This operation does not program Flash, but it temporarily halts the core while comparing and restores the original running state.

First run detection only:

```bash
node <skill-dir>/scripts/verify.js --workspace <workspace>
```

Report the selected ELF and SHA-256, target, probe, OpenOCD executable, compatibility result,
and returned `verificationAuthorization` plan. Stop if detection is incomplete or OpenOCD is
older than 0.12.0 (no plan is returned then). If the plan could not be issued, the preflight
carries `verificationAuthorizationError` and the script exits 1; report it and stop. Ask the user in the Agent conversation to approve this one verification,
explaining that it temporarily halts and restores the target. Only after approval run:

```bash
node <skill-dir>/scripts/verify.js --workspace <workspace> --execute --confirmation-id <id>
```

Explicit `--elf`, `--target`, `--probe`, and `--openocd` values take precedence over automatic detection. The script disables the target work area so verification cannot overwrite RAM, resolves all launch paths canonically, and restores the prior target state.

No second VS Code operation approval dialog appears. Confirmation IDs are one-time and
bound to verification, the image digest and connection; changed or expired plans require
fresh detection and a new human answer. A verification ID cannot authorize programming.

The final JSON line contains `verified`, `elf`, `elfSha256`, and mismatch `detail`. Exit code 0 means Flash matches the ELF. Exit code 1 with `verified: false` means it differs; report the detail and offer the programming workflow, but do not program without a separate explicit request and its confirmation.
