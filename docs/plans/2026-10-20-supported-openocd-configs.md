# Supported OpenOCD configuration packaging plan

**Goal:** Merge configuration names backed by the existing runtime into both bundled OpenOCD archives, keeping the executable and existing scripts unchanged.

**Architecture:** Add six small compatibility wrappers that source the canonical scripts already shipped by xPack. The wrappers cover STM32MP13/15, Renesas RZ/G2, RP2040 core 0, and Nuvoton's M0/M4 naming. Remove four obsolete catalog entries whose old backend or special emulation setup is not represented by the bundled runtime. Keep vendor configurations requiring missing flash drivers, obsolete DAP APIs or unknown chip identification outside the active bundles.

**Tech stack:** CommonJS packaging script, node-tar, OpenOCD Tcl, executable Node assert tests.

## Implementation

1. Record the original archive and executable hashes. Add reviewable wrapper sources under `resources/openocd-targets/target/` and a provenance manifest. Preserve adapter selection and delegate geometry, reset behavior and flash algorithms to canonical scripts. RP2040 core 0 uses the existing documented `USE_CORE` option.
2. Add `scripts/package-openocd-targets.js` to rebuild both platform archives deterministically from their existing payloads plus the six new files. Reject collisions and pin all original non-directory payloads, including symlink targets, with an aggregate digest. Retain the original upstream distribution hashes in the manifest.
3. Check all wrappers with bundled Windows OpenOCD, ending in `shutdown` without `init`; compare canonical and wrapper target/bank declarations. Check both archive inventories and existing payload preservation. Test Linux loading if a usable WSL environment is available; no hardware operations.
4. Update the fallback catalog, affected archive-hash tests, third-party notices and focused packaging documentation. Register a focused resource/manifest test and retain all pre-existing edits.
5. Run affected tests, `npm run check`, `npm run quality`, `npm run bundle`, Extension Host smoke tests and a local VSIX payload check. Report software compatibility separately from board validation.

## Exclusions

Do not add unsupported vendor flash drivers, silently substitute drivers, replace binaries, claim new chip families, edit README.md, change hardware settings or run HIL. Nuvoton M23 is excluded because a present driver name does not establish that its device IDs and flash behavior are supported.
