# EmberProbe UI 复刻（mockup）

用网页复刻 EmberProbe 插件在 VS Code 中的完整界面：整个 VS Code 编辑器外壳 + 插件侧边栏 + Live Watch 波形面板 + 调试界面。

侧边栏、Live Watch 页面与底部面板的 RTT 终端**直接复用插件的真实前端代码**（`src/modernView.js`、`src/liveWatchView.js`、`src/rttPanelView.js` 及 `src/webview/**` 资产），由生成脚本产出；VS Code 外壳、假数据与"扩展主机"由本目录手写，通过 `postMessage` 驱动真实渲染器。

> 所有数据均为模拟值，不连接任何硬件；VS Code 界面为手工近似复刻，与 Microsoft 无关。

## 快速开始

```bash
# 1. 生成 mockup/dist（调用插件自身的视图生成器）
npm run mockup            # 等价于 node mockup/build.js

# 2a. 直接双击打开
#     mockup/dist/index.html

# 2b. 或本地服务打开（推荐，避免个别浏览器对 file:// iframe 的限制）
npm run mockup:serve      # http://localhost:8085/

# 3. 冒烟测试（jsdom 加载真实渲染器并注入模拟消息）
npm run mockup:smoke

# 4. 宿主交互回归测试（也包含在 npm run check 中，无需先生成）
node test/mockup.test.js
```

改动 `src/webview/**`、`src/modernView.js`、`src/liveWatchView.js`、`src/rttPanelView.js` 后重新执行 `npm run mockup` 即可同步。

只改前端渲染时重新生成就够了；新增或改变了页面与扩展之间的消息（新命令、新消息类型、新字段）时，还要同步 `mock/*-host.js`，否则 mockup 中的新功能没有回应。

## 默认烧录与调试流程

打开 [mockup 首页](http://localhost:8085/)，默认使用浅色主题、`EmberProbeDemo.elf`、打开的 `pwsh` 底部终端，以及折叠收敛的初始侧栏与待读取的芯片信息卡片。

1. 点「烧录」。检查通过后，独立的 `EmberProbe OpenOCD` 终端按真实 `openocdRunner` 格式显示所选探针、固件路径、适配器/烧录时钟（含升频时钟）及写入、校验、复位进度，且主操作按钮在执行期间保持可点击。可在 MCU 配置中选择 `stlink.cfg` 来复现无匹配探针，或选择仍使用 SEGGER 驱动的 J-Link 来复现驱动错误。失败时侧栏展开已连接调试器，可选择带序列号的 CMSIS-DAP 重试。
2. 点「复位调试」。启动期间保留侧栏和当前编辑器，调试面板显示真实的 OpenOCD/GDB 暂停与寄存器状态，停在 `main` 的第一条语句后切到 `main.c` 并在左下角状态栏显示调试会话。默认无预置断点，点击「继续」后自由运行，可手动「暂停」（停在 `tasks.c` 的 `prvIdleTask`）、真正「单步调试/跳出」跨函数进入 `prvCheckTasksWaitingTermination` / `pid_update`、点击「重启」回到 `main`，或在左侧行号设置断点运行命中。
3. 停止后点「不复位调试」。新会话会在芯片当前运行位置（`tasks.c` 空闲循环）无复位附加，不打印 `Temporary breakpoint`，工具栏停止按钮改为「断开连接」。

调试位置和终端日志使用当前演示工程的模拟数据。

## 覆盖范围

- **VS Code 外壳**：标题栏（菜单、命令中心、窗口按钮）、活动栏（资源管理器/搜索/源代码管理/运行和调试/扩展/EmberProbe）、侧边栏视图、编辑器标签页、面包屑、C 语法高亮、代码缩略图、断点与当前行、底部面板（问题/输出/调试控制台/终端）、状态栏、命令面板、调试工具条、通知弹窗。
- **EmberProbe 侧边栏**（真实渲染器）：工具栏与语言切换、Agent Skill、OpenOCD 环境卡片、烧录/调试、内存区域分析、MCU 配置（ELF/调试器/芯片/SVD/CubeMX）、芯片信息（读芯片/暂停/继续/复位）、实时变量（监听/写入/变量浏览器/复合变量展开/右键数据断点）、RTT 卡片（启动/停止、通道选择、保存日志、时间戳）、外设寄存器（目录/寄存器/字段/读写）、FreeRTOS 任务表、探针诊断与日志。
- **Live Watch**（真实渲染器）：多序列波形图、当前值面板、频率与时间窗、采样时钟（自适应/手动）、波形背景图标（导入/显示开关）、冻结/归一化/清除、变量导入弹窗、CSV 导出（触发浏览器下载）、时间轴选择。
- **RTT 终端**（真实渲染器）：底部面板的“RTT 终端”标签页，每个 up 通道一个标签，输入框向带 down 缓冲的通道发送一行，↑↓ 历史，标题栏清除按钮。
- **调试界面**：变量树（含 `std::vector` / `std::string`）、监视、调用堆栈、断点列表与编辑器断点联动。调试变量树创建的原生数据断点显示在断点列表，侧栏数据断点由侧栏管理。

## 可交互项

- 活动栏切换、侧边栏与面板拖拽调宽/调高、面板折叠。
- 侧边栏：选择演示 ELF、调试器、MCU 或 `.ioc` / `.ioc2` 工程，开始/停止采样、单独添加结构体或数组成员、写入变量、读写外设、刷新 RTOS、读取芯片、烧录，以及下载或取消下载 SVD。内存刷新读取当前演示 ELF 的固定分析结果。
- RTT：首次启动后底部面板出现“RTT 终端”标签并切到前台；演示固件在通道 0 输出启动信息和每秒一行控制日志，通道 1 输出任务跟踪；在输入框输入 `help`、`status`、`rpm 1200`、`version` 可得到固件回应（`rpm` 会写入目标转速）。通道按钮打开 VS Code 式多选列表，勾选后运行中的 RTT 会重启；选“其他通道号…”可输入通道号。目标暂停时没有新输出。
- 数据断点：右键侧栏观察项或暂停时的调试变量树，可按值变化、读取或访问设置断点。两组断点共享每核 4 个模拟比较器。继续运行后，首个已启用且符合条件的断点触发停止。可用 `g_motor_rpm > 0` 这类路径与数字比较测试条件。移除侧栏观察项会清理它的侧栏断点，结束会话后清空该会话的两组断点。
- Live Watch：「波形」按钮打开独立窗口。各窗口可以从侧栏导入复合变量、冻结、清除和导出各自的历史。CSV 保存后可在 mockup 资源管理器的 `exports` 目录查看。
- RTT：在命令面板打开「RTT 工作区设置 (JSON)」，可修改 `emberprobe.rtt.channels`、解码方式、`input.mode`、`input.lineEnding`、`autoStart` 和日志选项。需要演示重定向时，可将通道设为 `[0, {"index":1,"down":0,"format":"hex"}]`，从通道 1 向固件通道 0 输入。再次点击「保存日志」会结束记录并下载日志及可能的 `.1` 备份。
- 外壳：命令面板（Ctrl+Shift+P，支持筛选与回车执行）、启动/停止调试（F5 / Shift+F5）、单步、断点开关、文件树折叠、标签页开关、问题跳转。
- 颜色主题：点击左下角管理齿轮，选择 **浅色现代 · Light Modern** 或 **深色现代 · Dark Modern**；也可在命令面板搜索主题名称。选择会保存在浏览器中，外壳、侧边栏与波形页同步切换，采样、历史、冻结状态和调试位置均保留。
- 调试工具栏采用 VS Code 的 Codicon、28px 高度与原版按钮颜色，位于窗口上部标签栏，可拖动，双击拖动柄可回到默认位置。执行箭头和断点共用编辑器左侧标记区；目标运行时禁用单步按钮。
- 内存刷新重新显示同一份 ELF 的固定分析结果，不随机增加 RAM 占用。
- 外壳与真实 Light Modern / Dark Modern 主题共用一致的色板与标准扁平边界（含菜单栏、窗口按钮与左下角调试会话状态栏）；默认浅色主题，初始展开底部 `pwsh` 终端与待读取的芯片信息卡片。
- 复位调试和烧录期间主操作按钮保持可用，状态点显示“正在执行”；Shift+F5 可取消等待。会话建立后在左下角状态栏显示调试会话并弹出调试工具条，到达 `main` 断点时打开源码。
- 加 `?debugCores=2` 可演示双核调试，在调用堆栈或 RTOS 会话下拉框切换核心。加 `?mcp=initialize`、`?mcp=tools` 或 `?mcp=timeout` 可演示 MCP 检测失败，成功状态使用从当前工具目录生成的数量。

## 目录结构

```
mockup/
  build.js               # 调用真实视图生成器，产出 dist/ 并注入 mock 桥接
  serve.js               # 无依赖静态服务器
  smoke.js               # jsdom 冒烟测试
  shell/                 # 手写的 VS Code 外壳
    index.html
    shell.css
    shell.js             # 外壳交互、调试状态、命令面板、宿主挂载
    shell-data.js        # 项目树、示例代码、调试数据、终端输出、命令表
  mock/                  # 浏览器端"扩展主机"与假数据
    theme.css            # VS Code Dark Modern 主题变量（注入 iframe）
    prelude.js           # acquireVsCodeApi 桥接（注入 iframe）
    theme.js             # 主题持久化及父页面/iframe 同步
    reference.css        # 真实截图的外壳布局与浅色工作区覆盖
    sidebar-data.js      # 变量/内存/芯片/外设/RTOS 假数据与数值模拟器
    configuration.js     # 演示工程配置与选择器
    sampling.js          # 采样读计划、速率测量及模拟链路时钟
    archive.js           # 按窗口和会话维护有上限的采样归档
    rtt-settings.js      # RTT 演示支持的工作区设置
    sidebar-host.js      # 响应侧边栏命令并推送模拟消息（含 RTT 卡片与数据断点）
    rtt-panel-host.js    # RTT 终端：各通道回滚、演示固件输出与输入回应
    text.js              # 宿主显示的文字：扩展的 src/i18n 字符串（构建为 dist/i18n.js）加演示固件文字
    livewatch-data.js    # 波形面板变量与配色
    livewatch-host.js    # 采样流模拟、导入/导出响应
  vendor/                # 官方 Codicon、Seti 文件图标及 Modern 主题颜色（含授权与来源）
  dist/                  # 生成产物（git 忽略）
```

## 工作原理

1. `build.js` 调用 `getModernWebviewContent()` / `getLiveWatchContent()` / `getRttPanelContent()` 生成三个页面的真实 HTML，并把 `src/i18n` 的字符串写成 `dist/i18n.js`，然后：
    - 注入 `theme.css`（VS Code CSS 变量，否则 iframe 内样式无颜色）；
    - 注入 `prelude.js`，在真实渲染器之前定义 `acquireVsCodeApi`，把命令 `postMessage` 给父页面；
    - 在 `<body>` 上标记页面类型与语言。
2. 外壳页面通过 iframe 嵌入这三个页面，`mock/*-host.js` 监听子页面的命令、回发与真实扩展相同形状的消息（`initCheck`、`availableVariables*`、`liveSample`、`peripheral*`、`rtos*` 等）。
3. 宿主共享变量模拟器和连接状态。侧栏按展开状态读取，波形按自身列表采样。模拟链路开销决定可用时钟与调度间隔，显示速率根据实际生成的采样批次计算。暂停后读取快照，成员列表变化时刷新该快照。
4. 语言切换：真实渲染器在原页面中更新语言，外壳保留 iframe 与宿主，新增变量、采样、波形历史和样式均继续保留。
5. 浏览器归档共用 16 MiB 模拟预算，按波形窗口和调试会话分开记录。归档满后停止采样。清除当前范围会回收预算，其他窗口及冻结快照可继续查看。CSV 支持筛选变量和时间范围，空数据不会下载。RTT 输出复用扩展格式化器。
6. 界面复用官方 Codicon 字体、Seti 文件图标与 Modern 主题色，叠加用户截图中的工作区布局和浅色颜色覆盖。紧凑标题栏隐藏传统菜单、应用标志和窗口按钮；命令面板仍可操作。所有资源从本地加载，无 CDN 依赖，来源和授权见 `vendor/README.md`。

## 限制

- 生成的 `dist/` 不提交；需要先执行 `npm run mockup`。
- 仅覆盖 Webview 自绘界面与 VS Code 常用外壳；菜单、窗口按钮等为演示占位。
- ELF、CubeMX 固件包、探针和调试目标是固定演示数据。采样时钟、烧录速度、断点命中和会话耗时也由浏览器模拟。MCP 检测使用本地演示响应，工具目录取自构建时的源码。
- CSV 和 RTT 的保存流程使用浏览器下载。模拟调试的源码位置来自演示工程，单步推进到下一条代码行。
- 本地服务器仅监听 `127.0.0.1`，非法 URL 编码返回 400；启动前需要生成 `dist/`。
- 个别浏览器可能限制 `file://` 下 iframe 的脚本运行，此时请使用 `npm run mockup:serve`。
