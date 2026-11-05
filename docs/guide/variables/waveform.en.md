# Waveform Panels

[中文](waveform.md)

A waveform panel plots how variables change over time. See the [README](../../../README_EN.md) for an overview and [Live sampling and history](sampling.en.md) for frequency and history.

## Multiple panels

You can keep several waveform panels open. Each has its own variable list, curve visibility, and history. After a VS Code restart, every panel restores its own content; a changed number only affects the title.

Closing a panel frees its number for a new one.

Panels saved by older versions are also restored. If two panels claim the same data, one receives an independent copy of the variable list and their histories stay separate. An older panel that cannot be identified opens with an empty list, and the lists already stored in the workspace are kept.

## Changing how a variable is displayed

Right-click a variable row, or press Shift+F10 on it, to change its type, number base, color, or line style. Press Escape or click outside to close the menu.

- **Number base**: DEC, HEX, and BIN only affect that variable's displayed value and hover reading in the current panel. The choice is cleared when the variable is removed.
- Fractions are converted numerically, so `1.5` becomes `0x1.8` or `0b1.1`. 64-bit integers stay exact.
- Enums show numbers in HEX and BIN and keep their names in DEC. Pointers keep their target labels.
- The base does not change sampling, curve positions, shared curve styles, or CSV exports.
- Composite rows have no base option.

## Temporary gain

Right-click a numeric variable, enter a factor under **Gain**, or step by 0.1 with `−` / `+`. The default is 1, and decimals, 0 and negative values are allowed.

- It only affects values, curves and hover readings in the current waveform panel.
- Sampling records, frozen data and CSV keep the original values.
- A negative gain flips the curve, 0 gives a flat line, and manual Y limits stay as they are.
- With a gain other than 1, enum names disappear and very large integers may round.
- Closing the panel, reloading or quitting the IDE resets it to 1. Removing the variable clears it.

Pointer addresses, strings and composite objects have no gain.

## Curve colors and line styles

A curve receives a style the first time it is enabled. Unused solid styles come first, followed by dashed and dotted ones. There are 144 preset combinations, and new colors are generated after that.

- Importing a struct, expanding members, or viewing hidden variables does not use up a style. A variable that has never been shown previews in gray.
- A hidden curve keeps its style and shows it again when re-enabled. Removing the variable releases it.
- Automatic styles are assigned per panel.
- In the context menu, click solid, dashed or dotted to switch line style.
- Colors and line styles you choose in the context menu are saved in the workspace and shared between panels.

## Related documents

- [Live sampling and history](sampling.en.md)
- [Waveform background icon](chart-background.en.md)
- [Webview UI design](../../design/webview-ui.md)
