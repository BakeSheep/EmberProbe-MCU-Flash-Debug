# Bundled OpenOCD target configurations

Both `resources/openocd-win32-x64.tar.gz` and `resources/openocd-linux-x64.tar.gz`
contain six EmberProbe compatibility configurations alongside the reviewed EmberProbe
scatter build based on xPack OpenOCD 0.12.0-7. Repacking preserves that build's executable,
scripts, libraries, licenses, file permissions and link targets. These names reuse existing implementations;
they do not add flash drivers or establish support for new chip families.

| Added configuration | Existing implementation | Purpose |
| --- | --- | --- |
| `numicroM0.cfg` | `numicro.cfg` | NuMicro M0 naming compatibility |
| `numicroM4.cfg` | `numicro_m4.cfg` | NuMicro M4 naming compatibility |
| `stm32mp13x.cfg` | `st/stm32mp13x.cfg` | Preserve the catalog name after upstream directory changes |
| `stm32mp15x.cfg` | `st/stm32mp15x.cfg` | Preserve the catalog name after upstream directory changes |
| `renesas_rz_g2.cfg` | `renesas_rz.cfg` | Use the current Renesas RZ target implementation |
| `rp2040-core0.cfg` | `rp2040.cfg`, `USE_CORE=0` | Configure only core 0 using the current multidrop SWD implementation |

The wrappers leave adapter and transport selection to the caller. Device IDs, bank layout,
erase/programming behavior and reset handling come from the canonical xPack scripts. In
particular, the NuMicro aliases do not import newer vendor chip IDs or claim support for
every M0/M4 part. Renesas RZ retains the canonical script's device-specific limitations.
Configuration loading does not establish compatibility with every EmberProbe managed
session feature or every board.

The fallback catalog also drops four absent legacy names: `nds32v2.cfg`, `nds32v3.cfg`,
`nds32v3m.cfg` and `vd_xtensa_jtag.cfg`. The bundled scripts discovered at runtime remain
the source of selectable target configurations.

## Integrity and rebuild

Reviewable wrapper sources are in `resources/openocd-targets/target/`.
`resources/openocd-targets-manifest.json` records their canonical source URLs, hashes,
build/patch/source identities, executable hashes and current augmented archive hashes.
An aggregate digest pins all reviewed non-directory entries, including permissions and
link targets. Each runtime archive contains the same provenance under
`distro-info/emberprobe-targets.json` inside its distribution root.

To regenerate both runtime packages from the locked build outputs:

```sh
npm run openocd:package -- --input test-results/openocd-scatter-release
npm run check:openocd-bundle
node test/openocd-target-bundle.test.js
node test/openocd-installer.test.js
```

The packager rejects mixed builds, missing dependencies/sources and conflicting wrapper files.
It streams the original tar entries without extracting them on the build host, preserving
Linux executable permissions and links when rebuilding on Windows. The installer already
uses archive hashes in its cache key, so the default runtime receives a new cache
directory without replacing a runtime used by another window. See the
[build and source distribution guide](../native/openocd/README.md).

## Compatibility boundary

For GD32, the bundled upstream E23x and VF103 target scripts remain unchanged.
Other vendor configurations needing unavailable drivers (including the previously reviewed
WCH, HPMicro, newer APM32/AT32 variants, STM32H5, additional Espressif and TI families) are
not copied into active runtime packages. Nuvoton's raw vendor scripts use an obsolete DAP
API, and the current `numicro` driver does not establish M23 device support.

Normal tests verify both archive inventories, source hashes, original payload preservation,
catalog consistency, installation/discovery, and loading all six wrappers on the test host.
OpenOCD exits through explicit `shutdown` without `init`, probe connection, erase or writes.
Real-board support requires separate hardware validation.

The configuration installation, discovery and declaration checks passed on Windows x64
and Linux x64 under WSL Ubuntu 26.04. In each environment, all six wrappers preserved the
canonical target/bank declarations and the selected adapter/transport. Neither run
initialized a physical adapter or accessed a board.
