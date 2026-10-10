# probe-rs environment and official installation

The probe-rs backend reuses the existing backend environment card, offering path selection and one-click installation when the executable is missing or invalid. The extension does not ship a probe-rs binary or archive.

## Implementation

- Resolve default probe-rs commands from PATH and the official user Cargo installation directories. Respect explicitly configured paths and the official installer directory overrides.
- Keep installation in a service. Execute the fixed official Windows PowerShell or Linux/macOS shell command, stream bounded output, hide Windows helper windows and enforce a ten-minute timeout. Bash pipefail propagates download failures from the Unix pipeline.
- Show indeterminate progress in both VS Code's notification and the environment card because the official installer does not report a total download size. Verify the resulting executable before saving its path.
- Deduplicate installation requests, keep quiet checks from overwriting progress, reject stale path selections and installation results, and recheck connection ownership before saving configuration.
- Check the environment before probe-rs debug/LiveWatch starts and downloads. Missing tools reveal the environment card and prevent a new hardware process. Existing hardware and session guards remain in force.
- Add the environment command to the command palette and restrict packaged tool archives to OpenOCD.

## Validation

Normal tests use local fixtures for official command selection, bounded streaming output, executable validation, installation and persistence failures, concurrent requests, stale settings, hardware ownership, missing-tool entry points and the rendered card in both languages. Extension Host tests exercise VS Code progress and configuration using a fixture installer and retain the owned DAP/flash regression suites. No real installer, firmware programming or driver switching is needed for these tests.

Required completion checks: `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`, plus a visual inspection of the missing and installing cards. Real official-script execution on each OS remains separate from fixture validation.

Completed on Windows x64 / Node 24:

- `npm run check`: 391 syntax/test entries, zero failures.
- `npm run quality`: lint, formatting, typecheck, 185 normal tests and coverage gates passed. Overall lines/statements 86.65%, functions 91.94%, branches 83.89%; the three environment/installer/status modules reached 100% lines.
- `npm run bundle` and VS Code 1.136.1 Extension Host tests passed, including the fixture installer through actual notification progress and configuration writes. Test temp files were placed under the workspace to avoid host temporary-directory permission restrictions.
- Chrome screenshots confirmed both the missing-tool card and installation progress at a 400-pixel sidebar width; artifacts are in `output/playwright/`.
- `vsce ls` confirmed that packaged resources contain OpenOCD and the Windows driver helper, with no probe-rs executable or archive.
- No real online installation, Linux/macOS execution or hardware operation was performed.
