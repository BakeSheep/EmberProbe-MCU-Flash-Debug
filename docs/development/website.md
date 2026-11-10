# 官网开发与发布

官网源码在 `website/`，使用静态 HTML/CSS/JavaScript。中文在站点根路径，英文在 `en/`，引导教程在 `demo/`。默认项目地址是 https://bakesheep.github.io/EmberProbe-MCU-Flash-Debug/。

## 本地预览与校验

```sh
npm ci
npm run site:build
npm run site:serve
npm run site:check
node test/website.test.js
node test/mockup.test.js
```

打开终端给出的地址（默认端口 8086）。预览故意使用 GitHub 项目子路径，以便发现根路径资源引用。`site:serve` 只监听本机；可用 `npm run site:serve -- 8090` 改端口。

`site:build` 先执行 mockup 构建，然后复制到 `website/dist/demo/editor/`。它只替换 `website/dist/`，不改扩展的 `dist/`。网站产物被忽略，不提交，也不加入 VSIX。`site:check` 会重新构建并检查页面、资源、海报、锚点及图片替代文本。

## 内容

双语文案在 `website/content.js`，HTML 模板在 `website/template.js`，样式和交互在 `site.css`、`site.js`、`motion.js`。版本读取根 `package.json`，不在页面内复制版本号。文案写用户得到什么，不写操作步骤和实现细节（时序、协议、内部回退等留给 `docs/guide/`）；事实仍以 `docs/guide/` 为准。

`content.js` 的章节 `id` 同时是 `website/capture/scenes.js` 中的场景名，录屏进度条的分段取自 `timeline.json` 中该场景的 `steps`。

### 采样专题区

采样是核心功能，在首页是一个带 `zone` 字段的章节（`id: "sampling"`），由 `template.js` 的 `samplingZone` 渲染，顶部导航只占一个入口。区内直接展示四个小节，不另设子导航：

- `modes`（`#sampling-modes`）：侧栏观测与波形图采样两张等宽对比卡，每张以真实界面截图（`mode-sidebar`、`mode-chart`）开头，按数据、记录、窗口三项对照。静默采样放在卡片下方独立的通栏区域，以隐藏、记录、重新显示三步说明，并注明只属于波形窗口。
- `states`（`#sampling-states`）：独立运行、调试运行中、断点暂停时三行，每行有自己的录屏（`sampling-standalone`、`sampling-debug`、`sampling-break`）、图标、编号和颜色（青绿、琥珀、红），录屏左右交替。
- `types`（`#variables`）：挂 `variables` 录屏，下方把各类型的真实界面截图（`type-*`）平铺成两列，按截图高度分列，让两列底部大致对齐。不放源码，也不做标签页。其中 `type-stl` 截的是内置调试器暂停时的变量视图（mockup 外壳 `shell-data.js` 的 `DEBUG.variables`，取值照 `src/debug/stl.js` 的摘要格式），文案写明属于调试器；实时采样不展开 vector、map 等容器。
- `chart`（`#waveform`）：挂 `waveform` 录屏，另有功能网格和右键菜单、CSV 导出两张截图；截图保留替代文本，不显示图下注释。

文案只写卖点。采样率不写具体档位：波形窗口的采样率可自定义，也可选不限速。

专题区沿用全站的白底、灰色边框、中性截图背景和阴影，不另设绿色章节边界。开场只保留局部淡青绿光晕，标题略大于普通章节；其他小节沿用全站字号与间距。独立的 `--sampling-accent`（`#0b8a7e`）与 `--sampling-dark` 用于波形、采样率、功能图标和标记，不覆盖全站品牌色变量；导航和播放控件沿用橙色。区内的小动画都只在 `.motion` 下生效，减少动画模式下直接显示完整的静态页面：

- 开头的波形先绘制出来，之后一条扫描光标循环扫过，光标后面的一段曲线加亮（SVG 遮罩 `#scope-sweep` 和 `.scope-cursor` 用同一套时序）。背景光晕保持静态，不再使用网格或指针照明。
- 数字卖点进入视口时文字上扫过一次高光；静默采样的圆点持续向外扩散。
- 三种状态进入时，色条自上而下画出，图标弹出，编号滑入；之后图标循环演示各自的状态：曲线反复绘制、继续按钮前推、断点向外脉冲。
- 支持悬停的设备上，卡片悬停时轻微上浮，方形标记转成菱形。上浮用 `translate`，不影响入场动画的 `transform`。

新增文案出现新汉字时要重新生成字体子集，否则 `test/website.test.js` 会失败。源字体不在仓库中：

```sh
FONTS=<源字体目录> node website/capture/fonts.js
```

### Agent 客户端与 MCP 能力

Agent 配置录屏下方平铺支持的客户端 Logo，再按六种任务展示 MCP 能力卡片。每张卡片显示图标、任务说明、能力标签与工具数量，使用原生 `details` 展开完整能力说明和工具名，支持键盘操作，不依赖 JavaScript。`content.js` 的 `agentClients` 和 `mcpTools` 供两种语言共用；具体能力说明放在各语言的 `agent.capabilities`，任务分组在 `agent.groups`。分组需覆盖 `src/mcp/tools.js` 的所有工具且不重复，网站测试会检查两种语言渲染出的完整工具列表。

Logo 在 `website/assets/clients/`，来源版本、品牌说明与 MIT 许可分别记录于 `NOTICE.txt` 和 `LICENSE`，构建时合并到 `credits.txt`。新增客户端时需同步更新本地 SVG、来源记录和客户端列表。

## 录屏

首页录屏全部来自 mockup 的真实前端，是提交到 `website/assets/media/` 的产物，CI 不录制。画面数据是模拟数据，不能作为硬件实测依据。前端或 mock 行为改变后需要重录对应场景。

录制依赖 ffmpeg 和 `playwright-core`，后者不是本仓库的依赖，用 `LIB` 指向含有它的目录：

```sh
LIB=<目录> node website/capture/record.js --preview waveform
LIB=<目录> node website/capture/record.js --lang=zh waveform
LIB=<目录> node website/capture/record.js
```

需要指定已安装的 Chromium 时，可设置 `CHROMIUM=<可执行文件路径>`；未设置时使用 Playwright 默认浏览器。

`--preview` 每 0.5 秒存一帧到 `test-results/website-capture/`，用来核对操作时序。不写语言时录中英文，不写场景时录全部，约需 30 分钟。

- 时钟由 Playwright 控制并逐帧推进，等待时间可以在场景中用 `skip` 缩短。场景只用选择器定位，中英文共用同一份脚本。
- 场景的 `window` 是页面上的显示尺寸。录制使用 2 倍像素，编码时不缩放，所以静止时视频按 1:1 显示。
- 单段不超过 2 MB，全部不超过 60 MB。超出时先缩短时长，再提高场景的 `crf`。
- `still: true` 的场景（首图）只在 `poster` 秒截一张无光标的图，输出 `hero-<lang>.webp` 和窄屏图，不编码视频。首图展示完整编辑器，首页保留整张截图的轻微 3D 透视和鼠标响应，不另加局部浮层，不持续缩放，也不设置常驻 `will-change: transform`。窄屏和减少动画模式关闭鼠标响应。
- 带 `cropTo: {on, to, pad}` 的静态场景按海报帧上选择器匹配元素的外接框裁剪（`on` 是 `sb` 侧栏、`lw` 波形窗口或 `page`），中英文排版不同也能裁准。`timeline.json` 中这类条目按语言分别记录 `zh`/`en` 尺寸，输出 `<场景>-<lang>.webp`。专题区的场景截图（`mode-sidebar`、`mode-chart`）、类型截图（`type-*`）和波形截图（`chart-menu`、`chart-export`）都用这种方式，变量来自 mockup 的“ELF 全部变量”，默认查看列表不变；`type-stl` 在页面上按 `#debugVariables` 中容器所在的行裁剪。
- 社交分享图由 `website/capture/og.js` 生成，需要先构建站点。

## 引导教程

`website/tour-data.js` 定义章节和步骤，`website/demo.js` 负责运行。每章使用全新的 mockup iframe，章节之间不共享状态。步骤高亮真实控件，等访客实际操作后才前进；控件禁用时不显示高亮。窗口窄于 900 像素时不启动教程，保留可横向滚动的编辑器。

修改 mock、前端选择器或教程步骤后，用真实鼠标键盘走完全部章节：

```sh
npm run site:build
LIB=<目录> node website/capture/check-tour.js
```

重新开始和切换章节都通过重建 iframe 实现，不清空其他标签页的 localStorage。

mockup 支持可选参数 `lang=zh|en` 和 `theme=light|dark`。非法语言回退中文；非法主题沿用原存储值或深色默认值。显式主题不修改已保存偏好。语言参数选择两页真实 Webview 的语言，VS Code 外壳的部分固定说明仍沿用原演示文本。

## GitHub Pages

仓库 Settings → Pages → Build and deployment 选择 **GitHub Actions**。需要仓库管理权限；CLI 登录可通过 `gh auth status` 检查，需要时由维护者执行 `gh auth login -h github.com`。不要把凭据写入仓库。

独立的 Website workflow 在 PR 中构建和检查，相关文件推送到 `master` 后自动部署，也可手动触发。GitHub `github-pages` environment 仅允许 `master` 部署。站点不调用 Agent Bridge、不连接探针、不需要服务端密钥。

首次部署后检查根首页、`en/`、`demo/?lang=en` 的直接访问与刷新，确认无资源 404，检查安装、文档、GitHub 链接，以及手机布局和减少动画设置。

回滚网站时，撤销造成问题的网站提交并推送，让 Pages 发布新产物；不要重定向已发布的扩展版本标签。官网发布与扩展 Release workflow 独立。
