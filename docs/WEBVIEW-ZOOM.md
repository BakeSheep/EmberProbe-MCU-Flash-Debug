# 页面滚轮缩放 / Webview wheel zoom

在 VS Code 设置中开启 **Editor: Mouse Wheel Zoom**（`editor.mouseWheelZoom`），将鼠标移到 EmberProbe
侧栏或波形图页面，按住 Ctrl 滚动滚轮：向上放大，向下缩小。macOS 也支持 Command＋滚轮。

缩放只影响鼠标所在页面，范围为 50%～200%。侧栏和每个波形窗口分别保存比例，恢复页面时继续使用该比例。
设置切换即时生效；关闭设置后保留当前比例，停止处理页面缩放手势。普通滚轮仍用于页面滚动、写入滑块调整或
波形坐标轴缩放。VS Code 原有的 Ctrl＋+/- 快捷键保持原来的窗口缩放行为。

Enable **Editor: Mouse Wheel Zoom** (`editor.mouseWheelZoom`) in VS Code. Hold Ctrl and scroll over the EmberProbe
sidebar or a waveform page to enlarge or shrink that page. Command+wheel is also supported on macOS.
Each page retains its own 50–200% scale. Disabling the setting preserves the current scale and stops intercepting
page zoom gestures. Ordinary wheel interactions and VS Code's existing window zoom shortcuts retain their behavior.

`src/webview/pageZoom.js` owns shared zoom state and conversion between viewport and layout coordinates. The host
returns settings through the shared message routes and broadcasts configuration changes; a focused page requests
the current setting again. Waveform hit testing, panel resizing, popup placement, card reordering and export
selection use the same coordinate conversions. The waveform canvas also adjusts its backing resolution for page
zoom. Viewport CSS variables and container queries keep the layout inside the page and responsive to its effective
width.

Software validation uses `test/webview-zoom.test.js` and the existing Webview/layout tests. Browser mockup checks
use simulated samples and do not establish hardware behavior.
