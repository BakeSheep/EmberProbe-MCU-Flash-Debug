# OpenOCD and Target Configurations

[中文](openocd-targets.md)

EmberProbe bundles OpenOCD for Windows x64 and Linux x64. Keep `emberprobe.openocdPath` at its default and nothing else needs installing. The target script list comes from the scripts shipped with the OpenOCD in use; pick one in the sidebar.

To use your own OpenOCD, choose it with **Configure OpenOCD Path** in the sidebar or set `emberprobe.openocdPath`, and use the scripts that came with that build.

## Additional target names

These names can be selected alongside the bundled scripts. They are aliases of existing implementations and do not add chip support:

| Target script | Uses | Purpose |
| --- | --- | --- |
| `numicroM0.cfg` | `numicro.cfg` | NuMicro M0 |
| `numicroM4.cfg` | `numicro_m4.cfg` | NuMicro M4 |
| `stm32mp13x.cfg` | `st/stm32mp13x.cfg` | STM32MP13 |
| `stm32mp15x.cfg` | `st/stm32mp15x.cfg` | STM32MP15 |
| `renesas_rz_g2.cfg` | `renesas_rz.cfg` | Renesas RZ |
| `rp2040-core0.cfg` | `rp2040.cfg` | Debug only core 0 of an RP2040 |

## STM32C0

Use `stm32c0x.cfg` for C011/C031/C051/C071/C091/C092. C0 has no JTAG pins, so `auto` transport uses SWD.

## STM32C5 (experimental)

Use `stm32c5x.cfg` for C531/C532/C542, C551/C552/C562 and C591/C593/C5A3. This support **has not been verified on real boards**.

- Use `interface/stlink.cfg`, J-Link or CMSIS-DAP as the debugger script. `interface/stlink-hla.cfg` does not support this target and is refused before starting.
- Only erasing, programming and reading Flash work. Option bytes and RDP are not available.
- Erase and programming speed have not been measured.
- Your own OpenOCD needs its own C5 scripts and Flash loaders; otherwise you get `FLASH_LOADER_MISSING`.

## Limits

- A target script that loads is not proof that every board or feature works. Real-board support needs separate validation.
- Vendor configurations that need extra drivers are not bundled, including WCH, HPMicro, newer APM32/AT32 parts, STM32H5, and additional Espressif and TI families.

## Related documents

- [Building and verifying the bundled OpenOCD](../../design/openocd-build.md)
- [Probe connections](probe-connections.en.md)
