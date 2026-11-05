# 页面滚轮缩放

[English](webview-zoom.en.md)

单独放大或缩小 EmberProbe 的侧栏和波形窗口，不影响 VS Code 其他部分。

1. 在 VS Code 设置中开启 **Editor: Mouse Wheel Zoom**（`editor.mouseWheelZoom`）。
2. 把鼠标移到侧栏或波形窗口上，按住 Ctrl 滚动滚轮：向上放大，向下缩小。macOS 也支持 Command＋滚轮。

- 缩放范围是 50%～200%，只影响鼠标所在的页面。
- 侧栏和每个波形窗口分别保存比例，重新打开时继续使用。
- 关闭设置后保留当前比例，但不再响应缩放手势。
- 普通滚轮的作用不变，仍用于滚动页面、调整写入滑块和缩放波形坐标轴。
- VS Code 的 Ctrl＋+/- 快捷键仍然缩放整个窗口。
