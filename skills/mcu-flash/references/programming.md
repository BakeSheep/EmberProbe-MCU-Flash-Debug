# Programming firmware

Use `scripts/program.js` from the Skill directory. Do not construct an OpenOCD shell command manually.

1. Run preflight without `--execute`:

   ```bash
   node <skill-dir>/scripts/program.js --workspace <workspace>
   ```

2. Report the detected ELF and SHA-256, target, probe, OpenOCD executable, and compatibility result. Stop if detection is incomplete or OpenOCD is older than 0.12.0.
3. If `flashAuthorization.authorized` is `true` with `mode: "workspace"`, a remembered permission covers this plan: report it with `trustedExpiresAt` and run `--execute` without `--confirmation-id`. Otherwise show the returned `flashAuthorization` plan and ask the user to approve. When `choices` includes `workspace`, offer it: it allows programming this ELF path through the same probe, target, transport, adapter speed and OpenOCD for 24 hours, including rebuilt images at that path. The initial request is not approval, and a confirmation ID must not be reused for a changed plan.
4. Only after explicit approval, repeat the same command with:

   ```bash
   node <skill-dir>/scripts/program.js --workspace <workspace> --execute --confirmation-id <id>
   ```

   Add `--remember` only when the user chose the workspace option. Never infer it from a request to flash.

Use `--permission` to inspect the remembered programming permission and `--reset-permission` to revoke it. Flash verification always needs its own one-time confirmation.

The Agent conversation is the operation confirmation surface. Show the actual image digest
and connection plan there and wait for the user's answer; EmberProbe does not display a
second operation approval dialog. A returned ID alone is not a human answer. Denial ends the
operation and must not be bypassed through direct OpenOCD execution. Flash verification has
its own confirmation plan because it may halt and resume the target; its ID cannot program Flash.

The script resolves executable and configuration paths canonically, prevents workspace Tcl/config shadowing, backs up target work areas, and executes OpenOCD `program ... verify reset exit`. Report the ELF fingerprint, exit code, and concise result. On failure, include the actionable output tail.

Explicit `--elf`, `--target`, `--probe`, and `--openocd` values take precedence over EmberProbe configuration and workspace/USB detection. Never guess values that detection cannot establish. On Windows, an incompatible OpenOCD can be replaced with EmberProbe's bundled xPack OpenOCD 0.12.0-7.
