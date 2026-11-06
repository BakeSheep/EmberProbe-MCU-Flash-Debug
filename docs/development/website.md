# 官网开发与发布

官网源码在 `website/`，使用静态 HTML/CSS/JavaScript。中文在站点根路径，英文在 `en/`，交互演示在 `demo/`。默认项目地址是 https://bakesheep.github.io/EmberProbe-MCU-Flash-Debug/。

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

`site:build` 先执行 mockup 构建，然后复制到 `website/dist/demo/editor/`。它只替换 `website/dist/`，不改扩展的 `dist/`。网站产物被忽略，不提交，也不加入 VSIX。`site:check` 会重新构建并检查页面、资源、锚点及图片替代文本。

## 内容与截图

双语文案在 `website/content.js`，HTML 模板在 `website/template.js`，样式和交互分别在 `site.css`、`site.js`。版本读取根 `package.json`。不在页面内复制一份版本号。

`website/assets/` 保存当前 mockup 的中英文浅色截图；它们是模拟数据，不能作为硬件实测依据。更改前端后，重新构建 mockup，在 `?lang=zh&theme=light` 和 `?lang=en&theme=light` 中分别操作并截图。`wave`、`config`、`flash`、`debug` 对应四个流程，`peripheral`、`rtos`、`memory`、`agent` 对应功能细节。保留关键字段并使用 PNG 无损压缩，不缩放或重画软件内容。`website/assets/capture-notes.md` 记录本次取景。

截图放大通过键盘可访问的按钮和原生 dialog 完成。首页波形是独立交互示意，明确标记无硬件实测。完整演示复用真实渲染器，iframe 重建即重新开始；不清空其他标签页的 localStorage。

交互演示的侧栏与波形页共享采样状态：任意一处启动或停止都会同步。复位调试停在 `main()`；暂停时保留快照，单步后读取新快照，继续运行后恢复采样。更新 mockup 行为后运行 `site:build` 即会应用到本地官网，并同步更新上述截图；生成目录不需要提交。

mockup 支持可选参数 `lang=zh|en` 和 `theme=light|dark`。非法语言回退中文；非法主题沿用原存储值或深色默认值。显式主题不修改已保存偏好。语言参数选择两页真实 Webview 的语言，VS Code 外壳的部分固定说明仍沿用原演示文本。

## GitHub Pages

仓库 Settings → Pages → Build and deployment 选择 **GitHub Actions**。需要仓库管理权限；CLI 登录可通过 `gh auth status` 检查，需要时由维护者执行 `gh auth login -h github.com`。不要把凭据写入仓库。

独立的 Website workflow 在 PR 中构建和检查，相关文件推送到 `master` 后自动部署，也可手动触发。GitHub `github-pages` environment 仅允许 `master` 部署。站点不调用 Agent Bridge、不连接探针、不需要服务端密钥。

首次部署后检查根首页、`en/`、`demo/?lang=en` 的直接访问与刷新，确认无资源 404，检查安装、文档、GitHub 链接，以及手机布局和减少动画设置。

回滚网站时，撤销造成问题的网站提交并推送，让 Pages 发布新产物；不要重定向已发布的扩展版本标签。官网发布与扩展 Release workflow 独立。
