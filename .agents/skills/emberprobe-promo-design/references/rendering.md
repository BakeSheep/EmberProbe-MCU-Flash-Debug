# 本项目的渲染与验收

在仓库根目录调用此项目 skill 的 `scripts/render-promo.cjs`。脚本使用现有 Playwright 和浏览器，等待图片、字体完成加载，导出 PNG、同构图预览及 JSON 报告；它不规定布局。

```text
node .agents/skills/emberprobe-promo-design/scripts/render-promo.cjs --input promo/emberprobe-082.html --width 3840 --height 2160 --preview-width 1600 --output promo/emberprobe-082-html-4k.png --preview promo/emberprobe-082-html-preview.png --report promo/emberprobe-082-render.json
```

这些文件名演示项目约定；其他版本替换版本号，保留 HTML 和原始截图。默认省略输出路径时，脚本在输入文件旁写入 `.png`、`.preview.png` 和 `.render.json`。

本地没有 Playwright 模块时，用 `--modules` 指向已安装的模块目录；默认 Chromium 不可用时，用 `--browser-path` 指向现有 Chrome / Chromium 可执行文件。在 Codex desktop 可用 `load_workspace_dependencies` 查找 runtime 和库；不要把当前用户的绝对路径写入 skill 或海报。

## HTML 标记与边界检查

画布根节点为 `data-promo-stage`；给品牌、版本、每个标题及短描述等独立叶节点添加 `data-promo-copy`。用 `data-promo-safe` 标记关键截图区域。合法截图叠放需要人工检查；保护区不能随意删除来隐藏文字遮挡。

脚本检查资源加载、脚本错误、画布尺寸、文案越界 / 裁切 / 重叠，以及文字与截图保护区相交。`ok: false` 时保留导出以便诊断，修复后重跑。

## 看图验收

1. 查看预览：品牌和版本有明确焦点，重点更新是一项一句，栏目标题可辨认，画面没有不必要的说明、序号或页脚。
2. 对照 `references/examples/emberprobe-080.png` 与 `emberprobe-082.png`：检查组合周围的空白、大小主次、错位和层次，而不是只检查是否旋转了图片。
3. 查看关键 UI：白色主题生效，文字与线条清楚，CPU 读数、覆盖率、枚举名称与数值完整；截图未失真，重叠未遮住证据。
4. 文案修改后重新导出并看新图。更长标题可能改变断行；不要仅更新 HTML 而交付旧 PNG。

输出可编辑 HTML、高清 PNG、预览与所需素材。图片内嵌或采用相对路径；参数集中管理，字体替换或换浏览器后需重新验收。
