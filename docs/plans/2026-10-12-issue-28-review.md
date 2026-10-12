# Issue #28 修复：复核结论（2026-10-12）

Issue: https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/issues/28
实现：Codex gpt-6.1-sol（max）两轮 + Claude 复核与补修。设计与完整文件清单见
[2026-10-11-deep-composite-layout.md](2026-10-11-deep-composite-layout.md) 与
[../DWARF-LAYOUT-RESOLUTION.md](../DWARF-LAYOUT-RESOLUTION.md)。**全部改动未提交。**

## 本机门禁（Claude 在沙箱外的普通 shell 复跑）

| 命令               | 结果                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`    | PASS，379 个文件，0 失败                                                                                                                                                                                                             |
| `npm run quality`  | PASS（eslint / prettier / tsc / 覆盖率与安全门槛）                                                                                                                                                                                   |
| `npm run bundle`   | PASS（Codex 报告的失败是它沙箱的文件系统限制）                                                                                                                                                                                       |
| `git diff --check` | PASS                                                                                                                                                                                                                                 |
| `npm run test:e2e` | 7/7 冒烟用例通过（含 sidebar / live-watch Webview 渲染、ELF Worker）；`test/e2e/suite/debug.test.js` 因本会话沙箱禁止子进程在 Temp 下 `mkdtemp`（EPERM）未能运行，与本次改动无关。**请在普通终端重跑一次 `npm run test:e2e` 确认。** |

HIL / 真机未运行；ODrive 实际 ELF 未验证（只用了模拟 libstdc++ `std::variant` 结构的夹具）。

## 第一轮（核心）

- 深度 / 节点预算 / 按值环 只截断对应分支：`unobservable: "depth-limit" | "expansion-budget" | "type-cycle"`，祖先 `truncated: true`，兄弟成员保留。
- 限制：复合嵌套 32 层（typedef/cv 不计，另有 256 跳别名上限）、每根 16384 节点、2 MiB 元数据；兄弟分支公平分摊预算。
- 截断节点不产叶子、不可写；叶子枚举、解码、watch、Agent watch/write、live-watch 读计划全部守卫。
- 缓存只保存完整子树。

## Claude 复核补修

- **残留的顺序依赖 bug**：公平分摊预算使重新构建比"缓存成本放得下"更严格，导致同一变量在预算紧张时结果取决于先展开了谁（已用最小复现确认）。改为：仅当当前剩余深度、节点、字节余量都不小于该子树当初构建时的余量才复用缓存（`src/dwarf/types.js` `_buildCompositeLayout`），并在 `test/dwarf-deep-layout.test.js` 加回归测试。删除了不再使用的 `layoutHeight`。

## 第二轮（UI 按需展开）

- 带 `expansionHandle` 的截断节点在 sidebar 与 live-watch 中可点击展开；加载 / 错误 / 过期状态有中英文文案。
- 子布局按"符号 + generation + 具体路径"独立保存（不修改根布局），地址累计数组 stride、成员 / 基类偏移；支持递归展开，每符号最多 32 次 / 8 MiB。
- 句柄 HMAC 签名、绑定 worker generation 与具体成员路径；ELF 变更后全部失效。
- STL 变量内已展开的静态叶子可选择 / 读取 / 观察；STL / runtime 写入仍拒绝，普通静态写入走原有授权指纹。

## 复核发现的行为变化（非阻断，请决定是否接受）

1. **ELF 重新加载后，来自展开路径的 watch 项会被移除**（会弹出 `lw.layoutWatchInvalid` 提示），需要重新展开并重新添加。这与既有"无法解析的 watch 项在 rebind 时被丢弃"的语义一致，但对深层成员的用户体验不理想；可考虑后续在 rebind 时自动按路径重新展开。
2. **`_saveWatchList` 现在会先用当前 ELF 归一化再持久化**（`src/mainViewProvider.js`）。ELF 仍在加载时 `readElfSymbols()` 会抛 `ELF_LOADING`，此时保存 watch 列表会报错（不会丢数据，但以前不依赖 ELF 状态）。
3. 新增的 `docs/plans/2026-10-11-deep-composite-layout.md` 是 Codex 的工作记录，提交前可决定是否保留。

## 回滚参考

- 第一轮之前的工作区：`git stash` 对象 `af3978a010c5e3a3575fe539f05274b5f016ddc3`（仅已跟踪文件；未跟踪文件副本已存到 `.git/issue28-baseline/round1-untracked/`）。
- 第二轮之前：`git stash` 对象 `b79657a2bd9b99cc0c2a751b4c8afda42fc3109e`（仅已跟踪文件；未跟踪文件副本在 `.git/issue28-baseline/round2-untracked/`）。stash 对象未被引用，git gc 约两周后可能清理；如需保留可 `git tag` 它们。
