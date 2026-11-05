# Variable Origin Filter

[中文](origin-filter.md)

Many variables in an ELF come from HAL, RTOS and libraries. The **User only** button at the top right of "All ELF variables" in the sidebar hides them, leaving those your code defines.

## Using it

Click the button to toggle. Turning it off restores the full list.

- The filter only changes the list, not reads, writes or sampling.
- Variables already in a watch or write list stay there.
- Hover over a variable name to see its category and source file.
- Variables that cannot be classified are kept.

## What gets hidden

| Category | Examples |
| --- | --- |
| Toolchain and runtime | Variables from newlib, libgcc, libstdc++ |
| RTOS | FreeRTOS, ThreadX, RT-Thread, Zephyr, plus `pxCurrentTCB`, `ucHeap` |
| Middleware | `Middlewares`, `Third_Party`, USB, FATFS, LWIP, LVGL |
| Vendor code | CMSIS, HAL drivers, `SystemCoreClock`, `uwTick`, CubeMX handles such as `huart1` |

## Limits

- `main.c` and `freertos.c` mix generated code with `USER CODE` sections. Generated handles and RTOS objects are hidden; your plain variables stay.
- Files under `USB_DEVICE/App`, `FATFS/App` and similar also have `USER CODE` sections, and their variables are hidden with the middleware. Turn the filter off when needed.
- Board code such as `Drivers/BSP` is not hidden.
- An ELF without debug information can only be judged by name, which is less accurate.

## Related documents

- [Variable identity and origin design (Chinese)](../../design/variable-identity.md)
