# 变量身份与来源分类设计

用户行为见[同名变量](../guide/variables.md#同名变量)和[变量来源筛选](../guide/variables.md#变量来源筛选)。

## 同名变量的身份

不同源文件中的 C `static` 或 C++ 匿名命名空间变量可以合法同名。EmberProbe 保留每个变量，并按编译单元给出唯一身份；正常加载 ELF 时不会因此显示警告。

ELF 缺少可读调试名称时保留链接符号名，不猜测变量身份。内部观察项、采样和写入保存完整的符号身份。Agent 读写对有歧义的裸名返回 `VARIABLE_AMBIGUOUS` 及结构化候选，必须明确指定目标；界面不会自动改选另一份变量。Escape、编辑输入或重新加载 ELF 会取消旧请求，迟到的响应不会添加变量。

真实的 ELF/DWARF 解析错误、预算超限和无法唯一确认的身份仍保留诊断。显式同名诊断和歧义说明优先使用已解析的可读名称，结构化候选保留链接符号身份供程序调用。

ELF/DWARF 诊断说明随界面所选语言显示为中文或英文，切换语言时已有提示会立即更新。诊断代码、文件名、路径和数值保留原值。原始解析消息继续保存在日志与接口结果中；现有诊断位置和显示时机不变。

## 来源分类依据

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
