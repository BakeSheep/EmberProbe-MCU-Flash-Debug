# probe-rs 断点接入修复

目标：修复独立安装时的源码断点入口、Agent 对不支持的断点请求给出成功结果的问题，并补齐断点调试验收路径。

采用标准 VS Code 语言注册与实际 DAP 能力检查。仅修改 launch 配置的 `languages` 不能开启源码断点入口；在 Agent 中按后端名称写死能力则会误判其他适配器或后续版本。Bridge 为每个会话记录断点能力，服务在添加或启用前检查选定会话，未知能力与明确不支持分别返回结构化错误。

- 在 `package.json` 注册 C、C++、ASM、Rust 的源码断点。
- 扩充 `debugSessionBridge.js` 的条件断点、命中次数断点和日志点能力，保留初始化、动态能力事件、会话切换和退出时的隔离。
- 在 `debugControlService.js` 检查函数及高级源码断点；普通断点仍可预设。删除和禁用允许清理不支持的断点；启用先验证所有匹配项，再修改 VS Code 状态。
- 扩充现有普通测试和 probe-rs Extension Host 测试：F9 创建 Rust 断点、DAP 验证、命中、调用栈、作用域、变量、单步、清除和继续。使用模拟适配器，不依赖连接的探针。
- 增加显式启用的真机断点验收脚本，使用已经烧录的匹配 ELF、源码与循环执行的源码行。该脚本 attach、设置硬件断点、检查命中与单步，最后清除断点并退出；本次不运行硬件操作。

更新 probe-rs 使用文档和 MCU Debug Control 技能的能力限制说明。保留已有工作区改动，不修改 README。

验证：先运行受影响测试，再运行 `npm run check`、`npm run quality`、`npm run bundle` 与 `npm run test:e2e`。硬件验收独立记录，软件测试不作为真实断点命中的证据。

验收记录（2026-10-10，Windows x64，Node.js 24.13.1）：

- `npm run check`：386 个测试文件，0 失败。
- `npm run quality`：ESLint、Prettier、类型检查和 182 个覆盖率测试文件通过；全局行/语句覆盖率 86.38%，分支 83.77%，函数 91.69%，服务及安全模块门禁通过。
- `npm run test:e2e`（包含 `npm run bundle`）：通过，使用隔离的 VS Code 1.136.1 Extension Host 验证 Rust F9、源码断点验证与命中、调用栈/局部变量、指令断点设置、单步、继续及 Agent 能力拒绝。
- 受影响普通测试、文档链接检查和 `git diff --check` 通过；真机脚本的显式启用防护已检查，未启动真实 probe-rs 调试会话或执行硬件测试。
