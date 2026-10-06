# EmberProbe UI 复刻（mockup）

用网页复刻 EmberProbe 插件在 VS Code 中的完整界面：整个 VS Code 编辑器外壳 + 插件侧边栏 + Live Watch 波形面板 + 调试界面。

侧边栏与 Live Watch 页面**直接复用插件的真实前端代码**（`src/modernView.js`、`src/liveWatchView.js` 及 `src/webview/**` 资产），由生成脚本产出；VS Code 外壳、假数据与"扩展主机"由本目录手写，通过 `postMessage` 驱动真实渲染器。

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

改动 `src/webview/**`、`src/modernView.js`、`src/liveWatchView.js` 后重新执行 `npm run mockup` 即可同步。

## 覆盖范围

- **VS Code 外壳**：标题栏（菜单、命令中心、窗口按钮）、活动栏（资源管理器/搜索/源代码管理/运行和调试/扩展/EmberProbe）、侧边栏视图、编辑器标签页、面包屑、C 语法高亮、代码缩略图、断点与当前行、底部面板（问题/输出/调试控制台/终端）、状态栏、命令面板、调试工具条、通知弹窗。
- **EmberProbe 侧边栏**（真实渲染器）：工具栏与语言切换、Agent Skill、OpenOCD 环境卡片、烧录/调试、内存区域分析、MCU 配置（ELF/调试器/芯片/SVD/CubeMX）、芯片信息（读芯片/暂停/继续/复位）、实时变量（监听/写入/变量浏览器/复合变量展开）、外设寄存器（目录/寄存器/字段/读写）、FreeRTOS 任务表、探针诊断与日志。
- **Live Watch**（真实渲染器）：多序列波形图、当前值面板、频率与时间窗、冻结/归一化/清除、变量导入弹窗、CSV 导出（触发浏览器下载）、时间轴选择。
- **调试界面**：变量树（含 `std::vector` / `std::string` 的 STL 展示）、监视、调用堆栈、断点列表与编辑器断点联动。

## 可交互项

- 活动栏切换、侧边栏与面板拖拽调宽/调高、面板折叠。
- 侧边栏：开始/停止采样（数值实时刷新）、变量搜索与添加/移除、写入变量、外设寄存器读取/写入、RTOS 刷新、芯片读取与控制、烧录进度、SVD 下载流程、语言切换（中/EN）。
- Live Watch：开始/停止采样（曲线实时滚动）、导入变量、导出 CSV、冻结/归一化、样式色板。
- 外壳：命令面板（Ctrl+Shift+P，支持筛选与回车执行）、启动/停止调试（F5 / Shift+F5）、单步、断点开关、文件树折叠、标签页开关、问题跳转。
- 颜色主题：点击左下角管理齿轮，选择 **浅色现代 · Light Modern** 或 **深色现代 · Dark Modern**；也可在命令面板搜索主题名称。选择会保存在浏览器中，外壳、侧边栏与波形页同步切换，采样、历史、冻结状态和调试位置均保留。
- 调试工具栏采用 VS Code 的 Codicon、28px 高度与原版按钮颜色，位于窗口上部标签栏，可拖动，双击拖动柄可回到默认位置。执行箭头和断点共用编辑器左侧标记区；目标运行时禁用单步按钮。
- 内存刷新重新显示同一份 ELF 的固定分析结果，不随机增加 RAM 占用。
- 外壳按提供的真实截图采用紧凑标题栏、居中项目命令框、原生布局按钮、圆角容器和灰色活动栏选中块。浅色模式的工作区背景、按钮边框与数值颜色按参考图覆盖；不包含截图中的其他插件图标或状态文字。
- 默认进入波形页，终端与调试工具栏收起；点击采样按钮查看曲线，F5 启动调试后显示调试工具栏。顶部前进/后退在访问过的编辑器标签间导航，保留波形 iframe 与采样历史；右上角自定义布局可切换主侧边栏、面板和空的辅助侧边栏。
- 点击“调试”或按 F5 后，等待约 2.2 秒才进入调试界面，期间显示原有“正在执行”状态并防止重复启动。Shift+F5 可取消等待。此延迟仅模拟操作响应的等待感；页面保持可操作，不注入旧版 OpenOCD 启动日志。

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
    sidebar-host.js      # 响应侧边栏命令并推送模拟消息
    livewatch-data.js    # 波形面板变量与配色
    livewatch-host.js    # 采样流模拟、导入/导出响应
  vendor/                # 官方 Codicon、Seti 文件图标及 Modern 主题颜色（含授权与来源）
  dist/                  # 生成产物（git 忽略）
```

## 工作原理

1. `build.js` 调用 `getModernWebviewContent()` / `getLiveWatchContent()` 生成两个页面的真实 HTML，然后：
    - 注入 `theme.css`（VS Code CSS 变量，否则 iframe 内样式无颜色）；
    - 注入 `prelude.js`，在真实渲染器之前定义 `acquireVsCodeApi`，把命令 `postMessage` 给父页面；
    - 在 `<body>` 上标记页面类型与语言。
2. 外壳页面通过 iframe 嵌入这两个页面，`mock/*-host.js` 监听子页面的命令、回发与真实扩展相同形状的消息（`initCheck`、`availableVariables*`、`liveSample`、`peripheral*`、`rtos*` 等）。
3. 两个模拟宿主共享变量模拟器，写入值会在后续采样中读回；波形面板可导入当前侧边栏查看列表，并按变量名去重。
4. 语言切换：真实渲染器在原页面中更新语言，外壳保留 iframe 与宿主，新增变量、采样、波形历史和样式均继续保留。
5. 波形宿主记录实际采样数据，最多保留 20,000 个采样批次；达到上限后丢弃最旧批次，并在导出弹窗提示截断。CSV 支持变量与时间范围筛选，复用插件自身的 CSV 序列化器（构建时生成 `dist/csv.js`），空数据不会下载空文件。
6. 界面复用官方 Codicon 字体、Seti 文件图标与 Modern 主题色，叠加用户截图中的工作区布局和浅色颜色覆盖。紧凑标题栏隐藏传统菜单、应用标志和窗口按钮；命令面板仍可操作。所有资源从本地加载，无 CDN 依赖，来源和授权见 `vendor/README.md`。

## 限制

- 生成的 `dist/` 不提交；需要先执行 `npm run mockup`。
- 仅覆盖 Webview 自绘界面与 VS Code 常用外壳；菜单、窗口按钮等为演示占位。
- 未接入真实探针/OpenOCD，烧录、采样、外设读写均为模拟。
- 单步演示按示例源文件的下一条代码行推进，不模拟指令执行、函数调用或控制流。
- 本地服务器仅监听 `127.0.0.1`，非法 URL 编码返回 400；启动前需要生成 `dist/`。
- 个别浏览器可能限制 `file://` 下 iframe 的脚本运行，此时请使用 `npm run mockup:serve`。
