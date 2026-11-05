# 数据断点实机验证记录（2026-11-05）

## 结论

重新插拔探针后，STM32H750 数据断点完整验收通过（当地时间延续至 2026-11-06）：真实 WATCH 右键创建并通过 VS Code 继续命中；`uwTick` 的 32 位写、读、读写断点，以及同一存储的 1/2 字节写监视范围均各命中三次。命中 ID、旧值/新值、调用栈、条件断点、删除后运行、重新启用和不支持的聚合大小拒绝均已验证。

初始业务计数器写断点没有命中，原因未确定；后续 CMSIS-DAP HID 通信曾断开，重新插拔后恢复。最终通过的整轮结果包含成功清理、恢复运行和断开会话。

所有改动保留在工作树 `.claude/worktrees/data-breakpoints`，分支为 `feat/data-breakpoints`，基于 `098e0b9`。没有提交、推送或发布。

## 硬件与工具

| 项目           | 本次配置或实测值                                                   |
| -------------- | ------------------------------------------------------------------ |
| 平台           | Windows 11，VS Code Extension Host 1.136.1                         |
| 探针           | CMSIS-DAP_JX，序列号 `0001A0000000`，VID/PID `c251:f001`           |
| 接口           | Windows HID，SWD，4000 kHz                                         |
| 目标配置       | `stm32h7x.cfg`                                                     |
| 内核           | Cortex-M7 r1p1，CPUID `0x411FC271`                                 |
| 芯片标识       | deviceId `0x450`，revId `0x2003`，Flash 128 KiB                    |
| 初次连接前状态 | running                                                            |
| OpenOCD        | xPack `0.12.0+dev-02228-ge5888bda3-dirty`，构建时间 2025-10-04     |
| GDB            | 本机 ARM GNU Toolchain 中的 `arm-none-eabi-gdb.exe`                |
| 实际匹配 ELF   | `H750_RttTest/build/AxiNoncached/H750_RttTest.elf`                 |
| ELF SHA-256    | `1f18ae2a4c1469473b96c15c39c06d07bfa5e9fe7b77d2a3fd0536bf0fc7addf` |

硬件访问通过隔离的 VS Code 开发宿主、实际 EmberProbe 扩展、生产服务和托管调试会话完成。没有绕过探针所有权直接启动硬件用 OpenOCD/GDB。当前会话原有 MCP Bridge 连接不可用，因此采用仓库的 Extension Host 硬件测试路径。

## 过程与证据

1. 两个最初选择的 ELF 与板上 Flash 不符，测试均在变量访问前中止并清理会话。用读取的 Flash 数据进行离线比对后，确认本地 AxiNoncached 版本匹配。
2. 在匹配版本上，完整比对了两个内部 Flash 装载段：`0x08000000` 起 16,640 字节，`0x08004100` 起 100 字节，合计 16,740 字节全部相同。
3. `g_rtt_test.streamSeq` 的数据断点信息与写断点创建请求成功，DAP 返回 verified。继续运行后 15 秒内没有收到数据断点停止事件。失败后查询得到 running，随后暂停、删除断点、恢复运行并断开，最终调试状态为 none。未测量当时的流发送配置，不能认定计数器未更新，也不能认定 DWT 已正确触发或配置。
4. 改用 `uwTick` 后，attach 成功，但读取 Flash 时出现 `Remote communication error. Target disconnected: error while reading: No error.`。该轮未进入数据断点设置。原测试清理的恢复运行请求返回 `The program is not being run.`，未能确认恢复运行。
5. 检查确认没有遗留 OpenOCD 或 ARM GDB 进程。下一次独立连接在读取芯片信息时失败，原始日志为：

    ```text
    Error: error writing data: hid_write/WaitForSingleObject: (0x000003E5)
    Error: CMSIS-DAP command CMD_INFO failed.
    ```

    UI 错误摘要显示“Flash 写入或擦除失败”，但这一步实际仅执行芯片信息读取；原始日志没有 Flash 编程操作。当时停止硬件重试，确认没有遗留 OpenOCD 或 ARM GDB 进程，目标状态无法确认。

6. 用户重新插拔探针后，读取确认目标为 running，重新 attach 和完整 Flash 比对通过。`uwTick` 位于 `0x20000080`，32 位写、读、读写断点各连续命中三次。写断点显示递增的旧值/新值，调用栈位于 `SysTick_Handler`；读断点显示当前值，调用栈位于 `HAL_GetTick`。
7. 用 `(volatile unsigned char *)&uwTick` 和 `(volatile unsigned short *)&uwTick` 的解引用子节点验证 1/2 字节写监视范围，各连续命中三次。最初使用数组指针强转视图被安全路径校验拒绝，未放宽生产校验。
8. 条件 `uwTick > 0` 的写断点创建成功；清除后查询确认 running，暂停后使用已激活 dataId 重新启用并命中。各轮清理均成功删除断点、恢复原先 running 状态并断开，调试状态为 none。
9. 快速自动 DAP 运行循环后，WATCH 菜单使用过期栈帧查询被拒绝，截图确认该状态下菜单项隐藏。为验证实际用户路径，界面验收移到首次 attach 后，通过真实右键菜单选择“Break on Value Change”，用 Enter 激活菜单，再通过 VS Code 继续命令运行，成功命中。断点列表显示已启用的 W 类型条目。正常交互验收通过；快速 DAP 循环的界面刷新限制未修改生产代码。
10. 最后两轮完整测试均以退出码 0 结束。最后一轮截图包含 `SysTick_Handler` 停止行、“Data breakpoint: uwTick”、硬件 watchpoint 旧值/新值和断点列表条目。截图时 WATCH 值仍显示 `not available`，该图证明停止和断点列表呈现，不作为 WATCH 值刷新完全稳定的证据。完整 DAP 值与调用栈检查通过。
11. `g_rtt_test` 作为大于四字节的聚合对象被 `dataBreakpointInfo` 拒绝，返回 `dataId: null`。最终清理删除测试断点、恢复 running、断开会话；`debug.status` 返回 none，系统中没有遗留 OpenOCD 或 ARM GDB 进程。

本轮没有下载固件、擦除 Flash、复位目标、切换驱动或写应用变量。设置/删除调试断点及暂停/继续属于本次授权的调试测试操作。

## 软件验证

功能实现阶段已通过：

- `npm run check`。
- `npm run quality`，包括 ESLint、Prettier、JSDoc 类型检查与覆盖率门槛。
- `npm run bundle`。
- `npm run test:e2e`：实际 VS Code DAP 数据断点信息、创建、模拟命中、删除及打包能力声明。
- `node test/gdb/data-breakpoints.test.js`：真实 ARM GDB 对模拟 RSP 目标的 write/read/readWrite 监视点创建、停止原因、旧值/新值和删除。
- `node test/gdb/external-debug.test.js` 与生命周期竞态测试。

迁入本工作树后，锁定依赖安装、bundle、数据断点单测、完整 `npm run check` 和 `npm run quality` 再次通过。后续硬件脚本修改另行通过 ESLint 和 Prettier。软件测试及模拟 RSP 结果不能替代实机命中证据。

## 测试脚本与后续验收

新增入口为 `test/hil/run-data-breakpoints.js`，套件为 `test/hil/data-breakpoints.test.js`；使用方式见 `test/hil/README.md`。脚本先核对板上固件，再允许使用 ELF 变量地址。异常清理现在即使删除断点或恢复运行失败，也会尝试断开调试会话；保留原始失败原因、状态和可用的 OpenOCD 日志。工作台截图连接及命令有超时，避免无限等待。

探针重新插拔后已恢复通信并重新核对固件。已验证的物理命中与启停行为见上文；硬件比较器资源耗尽尚未验证，断点列表的复选框交互尚未单独自动化。

1/2 字节指针视图被较宽的 CPU 指令覆盖，仅证明这些监视范围的重叠访问行为，不能当作原生字节/半字存储指令的验证结果。本轮未验证其他探针、其他 MCU、Linux、DMA 或其他内核访问。

## 本地证据文件

以下均为忽略的生成输出，不随源码提交：

- `test-results/data-breakpoints-board.json`：最近一轮完整通过的结果，包含真实菜单命中、所有监视范围、条件与启停、大小拒绝及清理；`passed: true`。
- `test-results/data-breakpoints-board-stream-counter-timeout.json`：完整 Flash 比对通过、业务计数器写断点未命中、清理成功。
- `test-results/data-breakpoints-board-2026-11-05T15-17-58-727Z.json`：系统节拍测试前发生远程断连及恢复运行失败。
- `test-results/data-breakpoints-board-initial-elf-mismatch.json`、`test-results/data-breakpoints-board-cached-elf-mismatch.json`：初始 ELF 不匹配结果。
- `test-results/data-breakpoints-board-logs/`：各轮隔离 Extension Host 日志，包含最后一次的芯片信息原始诊断。
- `test-results/h750-data-breakpoints-profile.json`：本机路径与明确硬件选择，仅供本地复现。

- `test-results/data-breakpoints-board.png`：实际工作台数据断点命中截图，已打开检查。
- `test-results/data-breakpoints-board-ui.txt`：截图时的工作台文本。
- `test-results/data-breakpoints-board-<startedAt>.json`：后续运行前自动归档的各轮历史报告，保留失败和通过记录。
