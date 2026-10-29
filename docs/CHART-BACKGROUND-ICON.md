# 波形图背景图标

打开 VS Code 原生设置（Ctrl+,），搜索 `@ext:BakeSheep.emberprobe background`，
在 **Chart Background Icon: Enabled** 中点击「导入/更换 PNG」，使用系统文件选择器选择图片。
点击「移除背景图标」删除已保存的图形；取消勾选可临时隐藏图标并保留蒙版。
也可在命令面板运行 `EmberProbe: 导入/更换波形背景图标` 或 `EmberProbe: 移除波形背景图标`。
波形图内的设置菜单不提供导入入口。

透明底图片直接保留图形的透明度；纯色底图片自动去除与图片边缘连通的背景。
复杂背景不能可靠抠图时，请先准备透明底 PNG。纯色底图片中与边缘不连通的区域会作为图形保留。

图形去色后，以主题前景色、6% 透明度居中显示在网格和曲线下方。
图形保持比例，适配绘图区宽高各 60% 的范围，空图表中也会显示。

上传限制为 4 MiB、任一边不超过 4096 像素、总计不超过 1600 万像素。
自动裁去透明留白，保存的形状蒙版最长边不超过 512 像素。
无法读取、抠图结果为空或保存失败时，原背景保持不变。

整个过程在本地完成，只保存 Alpha 形状蒙版，不保存原图颜色、原文件或路径。
导入期间通过 VS Code 通知显示处理状态；没有波形窗口时会打开一个波形窗口完成处理和预览。
设置在本机当前 VS Code 用户配置的所有项目中共享，重启后保留，不参与 Settings Sync。
同一窗口内的所有波形图即时更新；其他 VS Code 窗口重新获得焦点或打开波形图时刷新。

## Background icon

Open VS Code Settings (Ctrl+,), search for `@ext:BakeSheep.emberprobe background`,
then use **Import or replace PNG** or **Remove** under **Chart Background Icon: Enabled**.
The links open the native file picker; importing also opens a waveform view if none exists.
Uncheck the setting to hide the icon while retaining its mask. The same actions are available in the command palette.
Transparent PNGs preserve their alpha; opaque PNGs have a solid background removed from the image boundary.
Use a transparent PNG for complex backgrounds. Enclosed regions disconnected from the boundary remain part of the shape.
The monochrome shape follows the theme foreground at 6% opacity, centered behind the chart.
Only the cropped alpha mask (up to 512 pixels per side) is stored locally across projects in the current VS Code profile.
The original image and path are not stored or uploaded, and the preference is not included in Settings Sync.
