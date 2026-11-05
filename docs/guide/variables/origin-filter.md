# 变量来源筛选

[English](origin-filter.en.md)

ELF 里的变量很多来自 HAL、RTOS 和库。侧栏“ELF 全部变量”右上角的 **仅用户** 按钮把它们隐藏，只留下你的代码定义的变量。

## 使用

点击按钮切换。关闭后恢复完整列表。

- 筛选只影响列表显示，不影响读写和采样。
- 已加入查看或写入列表的变量不会被移除。
- 悬停变量名可以看到分类和源文件。
- 判断不了的变量一律保留。

## 隐藏哪些变量

| 分类 | 例子 |
| --- | --- |
| 工具链和运行库 | newlib、libgcc、libstdc++ 的变量 |
| RTOS | FreeRTOS、ThreadX、RT-Thread、Zephyr，以及 `pxCurrentTCB`、`ucHeap` |
| 中间件 | `Middlewares`、`Third_Party`、USB、FATFS、LWIP、LVGL |
| 厂商代码 | CMSIS、HAL 驱动，`SystemCoreClock`、`uwTick`，CubeMX 外设句柄如 `huart1` |

## 限制

- `main.c`、`freertos.c` 同时有生成代码和 `USER CODE` 段。生成的句柄和 RTOS 对象会被隐藏，你写的普通变量会保留。
- `USB_DEVICE/App`、`FATFS/App` 等目录下的文件也有 `USER CODE` 段，里面的变量会随中间件一起隐藏。需要时关闭筛选。
- `Drivers/BSP` 等板级代码不会被隐藏。
- 没有调试信息的 ELF 只能按名称判断，准确度较低。

## 相关文档

- [变量身份与来源分类设计](../../design/variable-identity.md)
