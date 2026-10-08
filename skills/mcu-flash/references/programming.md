# Programming firmware

Use `scripts/program.js` from the Skill directory. Do not construct an OpenOCD shell command manually.

1. Run preflight without `--execute`:

   ```bash
   node <skill-dir>/scripts/program.js --workspace <workspace>
   ```

2. Report the detected ELF and SHA-256, target, probe, OpenOCD executable, and compatibility result. Stop if detection is incomplete or OpenOCD is older than 0.12.0.
3. Show the returned `flashAuthorization` plan and ask the user to approve this one programming operation. The initial request is not approval, and a confirmation ID must not be reused for a changed plan.
4. Only after explicit approval, repeat the same command with:

   ```bash
   node <skill-dir>/scripts/program.js --workspace <workspace> --execute --confirmation-id <id>
   ```

When using the Agent Bridge, the extension also presents the actual snapshot digest and
connection plan in a VS Code approval dialog. Returning the confirmation ID cannot approve
that dialog. Flash verification also needs this approval because it may halt and resume the
target. A denied dialog must not be bypassed by switching to direct OpenOCD execution.

The script resolves executable and configuration paths canonically, prevents workspace Tcl/config shadowing, backs up target work areas, and executes OpenOCD `program ... verify reset exit`. Report the ELF fingerprint, exit code, and concise result. On failure, include the actionable output tail.

Explicit `--elf`, `--target`, `--probe`, and `--openocd` values take precedence over EmberProbe configuration and workspace/USB detection. Never guess values that detection cannot establish. On Windows, an incompatible OpenOCD can be replaced with EmberProbe's bundled xPack OpenOCD 0.12.0-7.
