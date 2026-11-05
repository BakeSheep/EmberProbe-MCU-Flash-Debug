# Waveform Background Icon

[中文](chart-background.md)

Show a faint icon, such as a team or project logo, behind the chart grid and curves.

## Setting the icon

1. Open VS Code Settings (Ctrl+,) and search for `@ext:BakeSheep.emberprobe background`.
2. Under **Chart Background Icon: Enabled**, click **Import or replace PNG** and choose an image.

The same actions are available in the Command Palette. The chart's own settings menu has no import option. If no waveform panel is open, importing opens one for preview.

- Uncheck the setting to hide the icon temporarily. Checking it again restores the icon.
- Click **Remove**, or use the remove command, to delete the saved shape.

## Image requirements

- The PNG must be at most 4 MiB, at most 4096 pixels per side, and at most 16 million pixels in total.
- Transparent images keep their transparency. This is the most reliable option.
- Images with a solid background have the background connected to the image edge removed. Regions not connected to the edge stay part of the shape.
- Complex backgrounds cannot be removed reliably, so prepare a transparent PNG first.

The shape appears in the theme's foreground color at 6% opacity, centered, keeping its proportions and fitting within 60% of the plot's width and height. It also shows on an empty chart.

## What is saved

- Processing is local. Only the monochrome shape is saved. The original image, its colors, and its path are neither stored nor uploaded.
- The icon is shared by all projects in the current VS Code profile on this machine and is not part of Settings Sync.
- Waveforms in the same window update at once. Other VS Code windows refresh when they regain focus or open a waveform.

If an import fails, for example because the image cannot be read, nothing remains after background removal, or saving fails, the current background stays unchanged.
