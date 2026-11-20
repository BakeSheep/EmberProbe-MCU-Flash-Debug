# 采样与波形验证流程

采样调度与读取边界见[采样链路设计](../design/sampling-pipeline.md)，数据与显示规则见[波形历史与归档设计](../design/chart-history.md)。

## Tcl 无回显

更换内置 OpenOCD 后，在仓库根目录执行以下检查。

```sh
npm run check:openocd-noecho
```

命令也可通过 `node scripts/check-openocd-noecho.js` 运行。它将当前平台的内置 OpenOCD 解包到 `test-results/`，用 dummy adapter 检查 Tcl 响应、无回显、普通回显和连接复用，无需真实探针。

## 波形历史与绘图

```sh
node test/perf/long-history-bench.js
node test/perf/unlimited-host-bench.js
node test/perf/layered-history-bench.js
```

三个基准分别衡量长会话索引与查询、宿主处理与归档编码、视口缓存与重建。它们使用合成数据。宿主基准不计磁盘写入，浏览器绘图需单独运行。

```sh
node mockup/build.js
node test/perf/layered-history-bench.js --browser-html
node mockup/serve.js 4175
```

在本机浏览器打开 `http://localhost:4175/layered-bench.html`。记录环境、数据规模、预热和采样轮次，以及是否计入磁盘与消息传输。把可复用的历史结果追加到本地 `docs/records/validation/sampling-performance.md` 或 `docs/records/validation/waveform-software.md`。

## 实板对照

`scripts/measure-sampling-scatter.js` 读取真实硬件。按 [HIL 流程](../../test/hil/README.md)确认授权、目标和探针，记录用于对照的 EmberProbe 版本、OpenOCD 构建、链路时钟和测试场景。软件基准只用于判断宿主、归档和绘图开销。
