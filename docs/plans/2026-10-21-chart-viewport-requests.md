# Chart viewport requests implementation plan

**Goal:** Keep recorded curves visible during navigation and advance follow bounds together with detail data.

**Architecture:** Separate watch configuration from viewport range. Schedule overscanned detail and full-history overview
requests through the existing single request slot, compose their decoded segments, and memoize the result. Keep latest
live status separate from rendering status and commit rendering status with accepted live detail replies.

**Tech stack:** ES2022 browser JavaScript, CommonJS Node tests, JSDOM, ChartHistoryStore and packed chart transport.

1. Change only history request state, scheduling, composition, loading and lifecycle handlers in
   `src/webview/liveWatch/renderer.js`. Preserve the existing value-panel changes and host protocol.
2. Update delayed-reply expectations in `test/chart-remote-history.test.js`. Add deterministic store-backed tests in
   `test/chart-viewport-requests.test.js` and register that file in `scripts/test-groups.js`.
3. Adapt the existing layered-history benchmark's injected viewport state to the new cache structure if necessary.
4. Run focused live-watch tests, all tests importing render-webview, check, quality, bundle and the benchmark once.
   Compare failures with the supplied baseline. Generated outputs are produced only by the requested commands.
5. Review the task diff against the starting files to verify unrelated changes remain intact. No commits, branches,
   E2E, hardware, publishing, packaging or network operations.

## 阶段结果（P0，2026-10-22）

已实现（未提交）：拖动/缩放期间回复照常采用（配置键与时间范围分离）、左右各一屏超采样、整段历史粗略底图、跟随模式边界与数据原子提交、Worker 回复类型化数组传输（`src/webview/liveWatch/chartTransport.js`）、组合曲线数组复用。复核时追加：冻结/恢复与显隐切换期间保留上一份身份未变的曲线（不闪空），同一失败请求不再逐帧重发。

验证：`npm run check`（437 个文件，0 失败）、`npm run quality`、`npm run bundle` 通过；新增 `test/chart-transport.test.js`、`test/chart-viewport-requests.test.js`。基准（Node/JSDOM，10 曲线 30 分钟全窗口）回复传输中位 40.3 ms → 2.0 ms，载荷 1.92 MB → 0.58 MB。

未验证：真实 VS Code Webview 中的拖动观感与 Canvas 耗时、Extension Host E2E（`npm run test:e2e`）、实板。后续：P1（跟随增量列缓存与增量推送、60 fps 平滑滚动、Path2D 平移）、P2（二进制分块归档 + LOD，突破 30 分钟上限）。
