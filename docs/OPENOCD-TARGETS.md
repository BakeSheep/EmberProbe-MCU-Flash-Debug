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

## STM32C0 and STM32C5

STM32C0 needs no additional files: the canonical `stm32c0x.cfg` and the `stm32l4x` flash
driver of the base build cover C011/C031/C051/C071/C091/C092. C0 has no JTAG pins, so a
J-Link with transport `auto` uses SWD for this target, as for other known Cortex-M scripts.

STM32C5 (Cortex-M33) is **experimental and not hardware-verified**. Upstream OpenOCD has
no C5 support yet; the build applies STMicroelectronics' pending reviews instead:

| Patch | Source | Content |
| --- | --- | --- |
| `0002-stldr-flash-driver.patch` | review 9697, patch set 8 | `stldr` flash driver running STM32CubeProgrammer flash loaders on the target |
| `0003-stm32c5x-target.patch` | review 9699, patch set 6 | `target/stm32c5x.cfg` |
| `0004-emberprobe-c5-local-loaders.patch` | EmberProbe | load the bundled loader for the detected DEV_ID; never download |

Review 9699 originally downloaded loaders from GitHub during `examine` (review 9698, not
applied). EmberProbe instead ships the three loaders from ST's `stm32c5xx-dfp` 2.1.0 under
`scripts/flash_loaders/stm32c5/` and pins their hashes in the manifest:

| DEV_ID | Devices | Loader |
| --- | --- | --- |
| 0x44F | C531/C532/C542 | `STM32C53x_C54x.xldr` |
| 0x44E | C551/C552/C562 | `STM32C55x_C56x.xldr` |
| 0x45A | C591/C593/C5A3 | `STM32C59x_C5Ax.xldr` |

Limits of this support:

- The configuration needs a debug-AP target that HLA cannot create (OpenOCD reports
  "The selected transport doesn't support this target"). EmberProbe rejects `stm32c5x.cfg`
  with an HLA adapter (`interface/stlink-hla.cfg`) before starting; `interface/stlink.cfg`
  uses the `st-link` driver (dapdirect SWD) and loads the configuration, as do J-Link and
  CMSIS-DAP.
- The loader only erases, programs and reads flash. Option bytes and RDP have no OpenOCD
  commands for C5.
- Erase/program speed and timeouts come from the loader. They have not been measured.
- An external OpenOCD needs its own C5 scripts and loaders; a missing loader is reported as
  `FLASH_LOADER_MISSING`.

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
