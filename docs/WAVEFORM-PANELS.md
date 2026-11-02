# Waveform panel persistence

Each waveform has a display number and a separate stable watch-list storage key. Renumbering a restored tab never selects another chart's variables, curve visibility, runtime expansions, or sampling/history scope.

VS Code restores hidden Webviews when they first become visible. Panel allocation therefore checks both registered panels and all EmberProbe Webview tabs in `window.tabGroups`, including tabs that have not been deserialized. It recognizes Chinese and English titles, and ignores other extensions' tabs.

The renderer saves `panelId` and `watchKey` through `setState()` at startup and on subsequent UI changes. `liveWatch.panelBindings` in workspace state reserves the storage identities of hidden tabs across restarts. Registry writes finish before a panel handles its messages and are flushed during extension shutdown.

## Compatibility

- Existing `mcu.watchList` and `mcu.watchList.N` keys remain valid. No workspace-wide migration is required.
- Older serialized tabs with a panel number recover their original storage identity. Without a saved number, the localized tab title identifies the legacy chart.
- A display-number conflict only changes the label. If the original storage identity is already owned by another tab, the restored chart gets an independent copy of its watches, curve visibility, and runtime expansions under a UUID-suffixed watch key. Samples and history remain independent.
- A legacy tab with neither a usable saved identity nor a recognizable title opens with an empty independent list. Its old workspace lists are preserved.
- Closing a tab releases its display number. Late messages from the disposed Webview cannot modify a replacement tab.

The regression cases are in the panel identity section of `test/chart-host.test.js`. The Extension Host smoke test also uses a real hidden, unregistered Webview tab to verify allocation against VS Code's tab inventory.

## Variable context menu

Right-click a watched scalar or press Shift+F10 on its row to change its type, number base, color, or line style. DEC, HEX, and BIN apply only to that variable's displayed value and hover reading in the current panel. The selected bases are saved with the Webview state. Removing a variable clears its base preference.

Fractional values use numerical conversion (for example, `1.5` becomes `0x1.8` or `0b1.1`), and exact 64-bit integer text is preserved. HEX/BIN show enum values numerically; DEC keeps the existing enum labels. Pointer summaries keep their target labels. Base selection does not change sampling, plotted coordinates, shared curve styles, or CSV exports. Composite rows have no base control. Press Escape or click outside to dismiss the menu.

## Automatic curve styles

Each panel allocates automatic styles only when scalar curves are first enabled for plotting. Importing a structure,
expanding its members, viewing hidden watches, and opening context menus do not reserve styles. An unstyled hidden
variable has a neutral gray preview until its curve is enabled.

The automatic palette contains 48 colors. Curves receive unused solid combinations first, followed by dashed and
dotted combinations: 144 preset color/line pairs in total, with additional generated colors beyond that. Once a
curve has been enabled, hiding it keeps its color, line style, and reserved slot. New curves skip those reserved
combinations, and enabling a hidden curve restores its original style. Removing the variable releases its slot.
Automatic allocations are local to each panel and are reconstructed when it is restored.

Colors and line styles explicitly selected in the context menu are saved in the workspace and shared between
panels. These overrides reserve automatic combinations in panels where that variable's curve has been enabled,
including while it is hidden.
Existing saved styles are retained because older records do not distinguish manual and automatic selections.
No styles are created eagerly from saved watch lists.
