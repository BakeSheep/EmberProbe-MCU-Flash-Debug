# 当前版本的 mockup 截图

`mockup/` 复用 `src/modernView.js`、`src/liveWatchView.js` 和 `src/webview/` 的真实前端，由模拟宿主提供数据。相关实现见仓库根目录的 `mockup/README.md`、`mockup/build.js`、`mockup/serve.js` 和 `mockup/mock/`。截图制作不需要连接探针。

## 生成与展示

在仓库根目录运行 `npm run mockup`，用 `npm run mockup:serve` 启动仅供本机查看的界面，在浏览器打开其输出 URL。不要手工修改 `mockup/dist/`；需要专门演示数据时，在 `promo/` 下保存独立 fixture / 宿主页面，引用重新生成的 mockup 文件。

通过界面的主题菜单切换 Light Modern；独立宿主页可响应 iframe 的主题请求并发送 `__emberprobeMockTheme: true, theme: "light"`。核对实际 webview 为 `vscode-light`，不要把深色截图后期改白。

fixture 必须通过正常宿主消息驱动真实渲染器，保持当前产品交互。使用模拟值可以演示行为，但不能据此声称硬件测量结果、性能或兼容性。

## CPU 与枚举的已验证演示契约

以下是 0.8.2 的消息参考，后续先检查当前源码和测试，再决定是否复用。

- CPU：`src/webview/sidebar/cpuLoad.js`、`test/cpu-load-view.test.js`。先发 `cpuLoad` 的停止状态，包含 `canStart: true`；在浏览器点击采样按钮，再发运行状态。
- 运行状态字段包括 `state: "running"`、`intentEnabled: true`、`ownsProbe: true`、`canStart: false`、`canStop: true`、`workloadPercent`、`coveragePercent`。同步 `hardwareAvailability.operations.cpuLoad`，使其他硬件按钮呈现真实的独占关系。
- 枚举：`src/webview/sidebar/renderer.js`、`test/enum-variables.test.js`。模拟 `sidebarWatchList` / 变量元数据，以及带 `enumText` 的 `liveSample.samples`；由真实 UI 显示 `.Active(3)`、`ClosedLoop(2)` 等名称与数值，不直接改页面标签。
- 模拟器若只返回已知标量，新增枚举要补入输出样本，不能只添加变量元数据。开始采样后核对每个演示枚举都得到值。
- 分别截取 CPU 与变量演示时，先停止 CPU 再开启变量采样，避免画面暗示独占 CPU 采样与其他硬件操作同时执行。

## 高清捕获与裁切

- 先确定海报中实际显示的截图尺寸，再选择原生捕获密度。通常以 2–3 倍逻辑尺寸重新渲染 UI；不能放大一张低分辨率图片后称为高清截图。
- 使用可用的浏览器截图工具。若支持 `deviceScaleFactor`，可在捕获时使用；否则可在本地 fixture 中放大真实 DOM 的渲染尺寸，并配合浏览器支持的视口与截图范围。遵守相应工具的 API 和视口限制。
- 不假设请求的视口高度等于截图文件高度。大型视口可能受浏览器窗口限制；检查实际图片尺寸和内容，确认 CPU 数值与末尾枚举行没有被截断。
- 截图区域裁切 API 若未按预期生效，先核对截图；可通过本地 fixture 的可见区域或最终 HTML/CSS 裁切聚焦，保持原始截图与比例。不要靠猜测坐标反复导出。
- 在 HTML 中通常只设置图片宽度和 `height: auto`。裁切容器与图片缩放、偏移分别计算，不能同时指定不匹配的宽高把 UI 拉长。
- 保存原图，记录当前版本、主题、实际像素尺寸和模拟数据来源。历史参考 PNG 不用作新宣传图的界面素材。
