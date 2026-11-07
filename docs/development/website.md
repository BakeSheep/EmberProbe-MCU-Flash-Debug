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

双语文案在 `website/content.js`，HTML 模板在 `website/template.js`，样式和交互在 `site.css`、`site.js`、`motion.js`。版本读取根 `package.json`，不在页面内复制版本号。文案只写功能、条件和能力边界，每条描述对照 `docs/guide/`。

`content.js` 的章节 `id` 同时是 `website/capture/scenes.js` 中的场景名，每章的步骤数必须等于场景的 `steps` 数。

新增文案出现新汉字时要重新生成字体子集，否则 `test/website.test.js` 会失败。源字体不在仓库中：

```sh
FONTS=<源字体目录> node website/capture/fonts.js
```

## 录屏

首页录屏全部来自 mockup 的真实前端，是提交到 `website/assets/media/` 的产物，CI 不录制。画面数据是模拟数据，不能作为硬件实测依据。前端或 mock 行为改变后需要重录对应场景。

录制依赖 ffmpeg 和 `playwright-core`，后者不是本仓库的依赖，用 `LIB` 指向含有它的目录：

```sh
LIB=<目录> node website/capture/record.js --preview waveform
LIB=<目录> node website/capture/record.js --lang=zh waveform
LIB=<目录> node website/capture/record.js
```

`--preview` 每 0.5 秒存一帧到 `test-results/website-capture/`，用来核对操作时序。不写语言时录中英文，不写场景时录全部，约需 30 分钟。

- 时钟由 Playwright 控制并逐帧推进，等待时间可以在场景中用 `skip` 缩短。场景只用选择器定位，中英文共用同一份脚本。
- 场景的 `window` 是页面上的显示尺寸。录制使用 2 倍像素，编码时不缩放，所以静止时视频按 1:1 显示。
- 单段不超过 2 MB，全部不超过 60 MB。超出时先缩短时长，再提高场景的 `crf`。
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
