# ELF 变量来源筛选

侧栏「ELF 全部变量」右上角的「仅用户」按钮会隐藏由工具或库生成的变量，只保留用户代码定义的变量。按钮状态保存在侧栏视图状态中；关闭后恢复完整列表。筛选只影响列表显示，不改变读写、采样或授权行为；已加入查看/写入列表的变量不会因筛选被移除。

## 分类依据

分类在扩展侧完成（`src/variableOrigin.js`），每个符号得到 `origin`：`user`、`vendor`、`rtos`、`middleware` 或 `runtime`。依据按优先级排列：

1. **源文件路径**：DWARF 编译单元的 `DW_AT_name`（相对路径与 `DW_AT_comp_dir` 拼接）。路径按目录段匹配，项目所在目录名不会误判。
   - `runtime`：`newlib`、`libgcc`、`libstdc++`、`picolibc`、`arm-none-eabi` 等工具链目录。
   - `rtos`：`FreeRTOS`、`CMSIS_RTOS(_V2)`、`ThreadX`/`AZURE_RTOS`、`RT-Thread`、`uC/OS`、`Zephyr`、`RTX` 目录及 `cmsis_os*.c`。
   - `middleware`：`Middlewares`、`Third_Party`、`USB_DEVICE`/`USB_HOST`、`FATFS`、`LWIP`、`SEGGER`、`TouchGFX`、`LVGL`、`TinyUSB` 等。
   - `vendor`：`CMSIS`、`*_HAL_Driver`、`*_StdPeriph_Driver`、`nrfx`、`mcux-sdk` 目录，以及只含生成对象的文件：`stm32*_hal*.c`、`stm32*_it.c`、`*_hal_msp.c`、`*_hal_timebase*.c`、`system_<厂商>*.c`、`syscalls.c`、`sysmem.c`、`fsl_*.c` 等。
2. **名称**：FreeRTOS/CMSIS-RTOS 内核对象（`pxCurrentTCB`、`ucHeap`、`Idle_Stack` 等）、HAL 全局量（`SystemCoreClock`、`uwTick` 等）、CubeMX 初始化状态（`FSMC_Initialized`、`HAL_RCC_*_CLK_ENABLED`）、C++ 编译器对象（vtable、typeinfo、guard）和 `std::`/`__gnu_cxx::` 对象。以下划线开头的全局名只在没有 DWARF 源文件时视为工具链对象。
3. **类型**：`*_HandleTypeDef`（CubeMX 外设句柄，即使定义在 `main.c` 中）和 CMSIS-RTOS 类型（`osThreadId_t`、`osThreadAttr_t` 等，CubeMX 在 `freertos.c` 中生成）。DWARF 类型尚未就绪时，按 CubeMX 句柄命名（`huart1`、`hdma_usart1_rx` 等）判断。
4. **缺少调试信息**：ELF 含 DWARF 时，没有任何 DWARF 变量记录的 C 符号来自预编译库（如 newlib）。带编号后缀的静态变量和 C++ 符号不适用此规则，因为它们的 DWARF 绑定可能缺失。

无法判断时一律视为 `user`，宁可多显示也不隐藏用户变量。

## 已知局限

- `main.c`、`freertos.c` 等 CubeMX 文件中同时包含生成代码和 `USER CODE` 段。筛选只按类型和名称识别其中的生成对象；用户在这些文件中定义的普通变量会保留。
- `USB_DEVICE/App`、`FATFS/App` 等中间件目录下的文件也有 `USER CODE` 段，其中用户定义的变量会随中间件一起隐藏。需要时关闭筛选。
- `Drivers/BSP` 等板级支持代码常由用户编写或修改，不会被隐藏。
- 未带调试信息的 ELF 只能依据名称判断，准确度较低。

悬停变量名可查看分类和源文件，便于确认筛选结果。
