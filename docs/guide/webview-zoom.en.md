# Webview Wheel Zoom

[中文](webview-zoom.md)

Enlarge or shrink EmberProbe's sidebar and waveform panels without affecting the rest of VS Code.

1. Enable **Editor: Mouse Wheel Zoom** (`editor.mouseWheelZoom`) in VS Code settings.
2. Hover over the sidebar or a waveform panel, hold Ctrl, and scroll: up to enlarge, down to shrink. Command+wheel also works on macOS.

- The range is 50–200%, and only the page under the pointer changes.
- The sidebar and each waveform panel keep their own scale, including after reopening.
- Turning the setting off keeps the current scale but stops responding to the zoom gesture.
- Ordinary wheel use is unchanged: it still scrolls pages, adjusts write sliders, and zooms waveform axes.
- VS Code's Ctrl+Plus/Minus shortcuts still zoom the whole window.
