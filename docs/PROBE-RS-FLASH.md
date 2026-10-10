# probe-rs 烧录行为

侧栏和文件夹菜单的下载使用一条 `probe-rs download --verify --reset --binary-format elf` 命令。镜像先经过现有 ELF32、小端、64 MiB 上限及文件身份检查，再复制到带 SHA-256 的私有快照；CLI 只读取快照。写后校验和核心 0 复位使用同一个 probe-rs session。校验失败会使命令失败，不会启动第二个复位进程，也不会自动重试写入。该顺序依据 [probe-rs 0.32 的 flash 实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/util/cli.rs#L380)。

下载前检查工作区信任、CPU 测量、探针占用、驱动切换和调试会话。自动 LiveWatch 会话可由下载入口停止：先等待 Bridge 脱离，再等待已捕获适配器的进程退出，之后才申请下载租约。退出未确认时返回 `PROBE_EXIT_UNCONFIRMED` 并保留原连接的租约。正式调试、外部调试、正在启动的会话和其他探针操作会阻止下载。异步停止和镜像准备后会重新检查门禁、后端设置及所选 ELF，避免按已变化的配置执行。

成功后，两个侧栏后端共用 ELF 刷新流程：清理变量及图表旧样本，刷新内存分析，重新绑定变量地址和布局，然后释放下载租约。原本正在采样时，刷新成功后自动重新 attach；下载期间新的停止请求、后端/镜像变化或扩展关闭会取消自动恢复。刷新失败或重连失败单独提示，已完成的烧录仍保持成功结果。

F5 `launch` 默认设置 `flashingConfig.verifyAfterFlashing: true`，显式配置 `false` 仍生效。`attach` 始终设置 `flashingEnabled: false`。F5 由 DAP 执行，侧栏私有快照服务不用于 F5。

## 进度与失败诊断

CLI stdout/stderr 的行会传入现有侧栏进度通道，最近六条可回放；单行最多 2,000 字符，诊断尾部最多 8,000 字符，子进程输出预算维持 1 MiB。CLI stdin 关闭，避免版本差异造成探针选择提示持续等待。

诊断包含 `code`、`stage`、`retryable` 和 `details`，后者包括镜像摘要、超时预算、退出码/信号、输出尾部及 `resultUnknown`。进度阶段从工具实际输出识别；没有明确阶段输出时使用 `download`。擦除、编程、校验或复位的文字不代表该步骤已成功，只有进程成功退出才确认完整请求序列。

单次命令默认超时 120 秒。超时以 `PROBE_RS_TIMEOUT` 返回；已经启动的失败命令以 `PROBE_RS_FLASH_FAILED` 返回并保守标记 `resultUnknown: true`，不自动重烧。镜像检查、最终门禁或可执行文件启动失败时，`resultUnknown: false`。超时和输出预算触发终止后，等待进程关闭才结束执行器、清理快照及释放下载租约；这不提供 Flash 回滚。

## 验证范围

无硬件回归见 [Flash 服务测试](../test/probe-rs-flash-service.test.js)、[provider 生命周期测试](../test/probe-rs-flash-provider.test.js) 和 [共用 OpenOCD 刷新测试](../test/flash-refresh.test.js)。测试使用临时 ELF、模拟 CLI/适配器及 Node 子进程，不连接探针。它们覆盖命令参数、快照身份/清理、失败及超时诊断、延迟退出、租约保留、前后门禁、刷新和恢复。

2026-10-10 在 Windows x64、Node 24.13.1 上通过 `npm run check`（388 个语法/测试文件）、`npm run quality`、`npm run bundle` 和完整 `npm run test:e2e`。新增 [Extension Host 烧录场景](../test/e2e/suite/probe-rs-flash.test.js) 还单独通过，使用真实 Node 假 CLI/适配器进程验证退出、快照、刷新和自动重新 attach。烧录服务行/语句覆盖率 96.36%、函数 100%、分支 81.81%。E2E 改用工作区隔离临时目录解决系统临时目录权限问题；完整套件曾在已有源码断点场景超时，重试后通过。此次未验证 Node 20、Linux/macOS 或实板烧录行为。

Agent Flash 仍仅支持 OpenOCD；更多输入格式及协议选择 UI 不属于这次修复。实板烧录、校验失败注入、复位、重连及驱动切换尚未因本次软件回归获得硬件验证；硬件验收继续遵循 [HIL 指南](../test/hil/README.md)。

## English

Sidebar/folder downloads now use one digest-bound ELF snapshot and one probe-rs process with mandatory readback verification and reset. Automatic watch sessions must detach and physically exit before download ownership is acquired; all gates are checked again after asynchronous preparation. Successful flashes share OpenOCD's symbol/sample refresh and sampling restoration, respecting newer stop requests. F5 launch defaults to verification while preserving explicit overrides. Bounded CLI progress and structured failure/timeout diagnostics conservatively identify unknown firmware state; no automatic retry or hardware validation is implied.
