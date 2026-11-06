# 官网界面素材

2026-11-07，基于 EmberProbe 0.9.1 当前 mockup 生成，并在采样与调试状态同步修复后重新截图。所有数值、烧录、探针、调试和任务均为模拟，不代表实测性能或已验证硬件。

- 使用 Chrome、Light Modern，分别通过 `?lang=zh&theme=light` 和 `?lang=en&theme=light` 打开。
- 全窗口截图为 1440 × 900；功能截图为实际侧栏元素截图，不拉伸内容。PNG 使用浏览器原生无损编码。
- `wave`：启动采样、选择 10 秒窗口、打开归一化，积累模拟采样后截图。
- `config`：展开 MCU 配置，显示检测入口和固件、探针类型、目标配置。
- `flash`：点击烧录，等待完整模拟写入、校验与复位流程结束，保留完成状态和 OpenOCD 终端日志。
- `debug`：复位调试暂停在 `main()` 的首条语句，显示源码停止行和调试工具栏；不显示旧版额外的工具栏标签和扩展连接状态。
- `peripheral`：暂停状态下展开 GPIOA 和第一个寄存器，呈现位域及读数。
- `rtos`：继续运行并命中 ControlTask 断点后刷新任务，展开 ControlTask 查看栈及运行详情。
- `memory`：展开烧录区的内存分析，显示 FLASH、RAM 和 CCMRAM。
- `agent`：展开 Agent 配置和 MCP 客户端列表。

使用的真实渲染器和第三方图标许可见 `mockup/vendor/README.md`；构建会将完整许可复制到网站 `credits.txt`。
