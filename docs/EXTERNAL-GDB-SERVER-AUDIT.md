# 实验性外部 GDB server 支持审计

审计日期：2026-10-06。范围：当前 EmberProbe 源码，以及相邻 cortex-debug 工作区的 external controller。本文是可行性评估与待实施建议；未新增外部服务器支持，未连接硬件。

## 结论

可以增加，适合先做范围受限的实验功能。现有 GDB/MI、DAP、变量展示、暂停内存读取、会话路由与停止代次机制可以复用；主要工作是解除启动与控制流程对托管 OpenOCD 的假设。仅增加配置枚举或放宽连接地址校验不足以完成支持。

建议首版使用 `type: "emberprobe"`、`servertype: "external"`，只连接用户已启动的 Cortex-M / ARM32 GDB server，先支持单会话 attach。扩展持有本地 GDB，外部进程由用户管理。协议连接可能暂停目标，因此 attach 不等于无侵入观察。

## 现有接入阻碍

以下 P1/P2 表示实现该功能前的处理优先级，不代表当前 OpenOCD 模式已经存在相同缺陷。

| 优先级 | 位置 | 发现与影响 | 必要处理 |
| --- | --- | --- | --- |
| P1 | `src/services/debugConfiguration.js:21,91`；`src/debug/session.js:436` | 配置只接受 openocd，清除用户 gdbTarget；适配器只接受 127.0.0.1 的托管地址。 | 按后端分别验证配置；只在 external 模式保留经过验证的用户地址，继续清除用户伪造的内部 token。 |
| P1 | `src/mainViewProvider.js:637,685,722,1472` | 启动依赖探针选择、目标 cfg、OpenOCD 解析、物理探针预检、端口分配和 OpenOcdDebugController。即使服务器已启动仍走此流程。 | 在进入探针解析和硬件预检之前分流 external；复用 ELF、工具链、SVD、printer、启动超时和 DAP 跟踪。不得触发驱动切换或启动第二个 OpenOCD。 |
| P1 | `src/debug/session.js:460,463,465,468,875` | 固定使用 extended-remote，attach 固定 monitor halt，launch/restart 固定 monitor reset halt。已有 pre/post hooks 不会替代这些命令。 | 抽出后端命令策略。external 首版没有默认 monitor/reset/download；支持显式 remote/extended-remote 选择，不能假设所有 server 都懂 OpenOCD 命令。 |
| P1 | `src/debug/session.js:888`；`src/debug/mi.js:165`；`src/mainViewProvider.js:1580` | DAP disconnect/terminate 都只停止本地 GDB；托管 controller 清理与进程退出、租约释放相连。 | external 清理只处理本地 GDB 与本次连接资源，不杀外部进程、不发送 monitor exit。明确 target-disconnect 与 detach 的不同目标行为，验证退出失败和重复清理。 |
| P1 | `src/mainViewProvider.js:4082` | 最后一个调试会话结束后，采样意图会触发自动启动独立 OpenOCD。外部服务器可能仍占用探针。 | external 退出和启动失败均不自动恢复物理采样。外部占用状态与 DAP 生命周期分开处理；进程不归扩展所有，不意味着物理探针可用。 |
| P1 | `src/mainViewProvider.js:968,1855,2321` | 非共享托管服务器的写入身份取 server.options；侧栏 ELF 与所选会话 executable 的严格匹配目前仅在 shared group 路径执行。 | external 暂停写入绑定 DAP sessionId、工作区和停止代次，保留现有授权与读回校验；扩展 ELF 一致性保护，不能把外部 endpoint 误当 OpenOCD 物理配置，也不能退回临时探针写入。 |
| P2 | `src/debug/session.js:454,474`；`src/services/rtosViewService.js:20` | RTOS 名称同时控制 OpenOCD 设置与适配器线程感知；未启用时初始线程固定为 1。 | 区分 server 自行提供的线程与扩展配置 RTOS。确认实际停止状态和线程 ID 后再报告 ready/stopped，不猜测 server 的线程编号或 RTOS 能力。 |

另需给 `package.json` 的 launch/attach schema、配置片段与中英文说明添加 external 专属选项。当前工具链预检同时寻找 GDB 与 objdump；首版可以保留该要求，不能宣称安装一个 GDB 即满足所有预检。

## 建议首版能力边界

| 能力 | 建议 |
| --- | --- |
| 已运行服务器的 TCP 连接 | 支持；默认 localhost，也可显式配置主机；严格解析主机和 1–65535 端口，支持范围需写入 schema。 |
| 断点、调用栈、局部变量、Watch、STL、暂停/继续/单步 | 复用现有 DAP/MI；最终能力依赖 server、GDB 和目标，逐项验证。 |
| 暂停内存与 SVD、Agent 读取 | 复用选定 DAP 会话，保持字节预算、过期结果失效和 ELF 身份检查。 |
| 写入 | 仅在现有授权与所选会话身份保护均通过时开放；不得因 external 模式放宽权限。 |
| launch 下载、复位、restart | 首版明确拒绝，更新 DAP restart 能力；后续按 server 策略和显式配置开放。 |
| 运行期 Live Watch / Tcl 采样 | 关闭；暂停时走 DAP，不能以周期性暂停/继续模拟非侵入采样。 |
| RTOS | 线程展示依赖 server；FreeRTOS 面板可复用本地 ELF 与暂停有界读取，但单独验证，不能承诺自动配置外部 server 的 RTOS。 |
| serverGroup / 多核共享生命周期 | 首版拒绝；现有组校验与租约按托管 OpenOCD 设计，不能直接套到 external。 |
| server 启停、驱动操作、串口/管道连接、SWO/RTT | 不纳入首版。 |

以下只是拟议配置形态，目前不能使用：

```json
{
  "name": "EmberProbe: External GDB (Experimental)",
  "type": "emberprobe",
  "request": "attach",
  "servertype": "external",
  "gdbTarget": "127.0.0.1:3333",
  "executable": "${workspaceFolder}/build/app.elf",
  "gdbPath": "C:/toolchain/bin/arm-none-eabi-gdb.exe",
  "cwd": "${workspaceFolder}"
}
```

连接地址不得成为任意 GDB target 表达式：拒绝换行、控制字符、额外参数及 `| command` 管道形式。GDB 官方说明该管道形式能够运行 shell 命令。首版限 TCP 可避免无意扩大执行面。

## 架构决策草案：外部连接与物理后端分离

状态：建议，尚未实施。

新增 external 连接生命周期服务或 controller，并通过工厂选择后端。保留 OpenOcdDebugController 的进程退出确认语义；external 声明 `ownsProcess: false`、`runtimeRead: false`，不创建采样 Worker。适配器复用通用 GDB 初始化、符号加载和 DAP 请求，后端策略决定连接方式及初始化/复位/退出命令。

token 仍由扩展生成，用于绑定启动 watchdog、adapter tracker、失败清理和会话身份；token 表示这次连接受扩展协调，不表示外部服务器归扩展所有。

探针协调仍应保守：external 活跃期间阻止本扩展启动竞争硬件操作。结束连接后不自动恢复采样，也不以 TCP 端口关闭作为探针释放证明。具体占用解除入口需要在实现时确定；当前协调器只能约束本扩展，不能保证其他应用没有操作同一探针。

不建议首版实现 SEGGER/ST-LINK 专属进程启动器：那将额外引入工具探测、命令行、复位下载、日志就绪识别、进程所有权和驱动策略。先接入已有 server，可以隔离这些后端差异。

也不建议直接转交 Cortex-Debug 作为本功能实现：虽然现有 Bridge 已跟踪 cortex-debug，内置 RTOS snapshot 请求仅支持 emberprobe，会改变功能一致性及扩展依赖。相邻源码 `cortex-debug/src/external.ts` 可作参考：不分配 server 端口、不启动 server，但它也默认发送 monitor halt/reset；不能据此推出任意 server 的兼容性。

## 验收要求

1. 配置成功与失败：TCP 主机/端口、remote 模式、恶意地址、external 与 OpenOCD 专属参数冲突；OpenOCD 既有配置继续有效。
2. 不碰托管硬件路径：external 启动不枚举/预检探针，不要求目标 cfg，不解析或 spawn OpenOCD，不切驱动，不创建运行期采样 Worker。
3. 命令序列：attach 不隐式 monitor/reset/load/run-to-entry；禁止的 launch/restart 确实返回错误；服务器停止状态通过 MI 确认。
4. 会话边界：read/write/RTOS 绑定所选会话；恢复运行、重新连接、切换会话后拒绝旧句柄与旧确认；工作区 ELF 不匹配时拒绝侧栏地址读取与写入。
5. 生命周期：连接拒绝、超时、hook 失败、MI 断开、取消、adapter exit、重复 stop、扩展关闭；只关闭本地 GDB，外部进程保持存活，不自动恢复物理采样。
6. 测试分层：普通测试用 fake MI 验证编排；增加真实 GDB 对受控 RSP fixture 或工具型 server 的协议测试，避免仅由 mock 接受命令就宣称协议兼容；Extension Host 覆盖 F5 attach 与 Stop。
7. 实现交付运行 npm run check、npm run quality、npm run bundle、相关 E2E 与 GDB 入口。实板测试单独授权和记录 OS、GDB/server 版本、板卡、探针、固件与退出后的目标状态。

## 本次验证

Windows，Node.js v24.13.1。以下六个现有测试入口全部通过：

- `node test/debug-server-controller.test.js`
- `node test/ember-debug.test.js`
- `node test/debug-session-routing.test.js`
- `node test/debug-control.test.js`
- `node test/cortex-debug-integration.test.js`
- `node test/debug-session-bridge.test.js`

这些结果确认已有复用基础与保护机制的回归基线；不是 external 支持或实板兼容性证明。本次未运行全量 quality/bundle/E2E，未修改实现代码，未进行烧录、复位、驱动切换或 HIL。

## 协议参考

- [GDB：连接方式、remote / extended-remote、detach / disconnect、monitor](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Connecting.html)：连接模式支持和 monitor 命令依赖目标；detach 通常恢复执行，disconnect 通常不恢复，最终行为仍依赖 stub。
- [Cortex-Debug：External GDB server 配置](https://github.com/Marus/cortex-debug/wiki/External-gdb-server-configuration)：作为配置设计参考，不代替 EmberProbe 的独立验收。
