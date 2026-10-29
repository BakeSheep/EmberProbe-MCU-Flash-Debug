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

The regression cases are in `test/chart-panel-identity.test.js`. The Extension Host smoke test also uses a real hidden, unregistered Webview tab to verify allocation against VS Code's tab inventory.

## Variable context menu

Right-click a watched scalar or press Shift+F10 on its row to change its type, number base, color, or line style. DEC, HEX, and BIN apply only to that variable's displayed value and hover reading in the current panel. The selected bases are saved with the Webview state. Removing a variable clears its base preference.

Fractional values use numerical conversion (for example, `1.5` becomes `0x1.8` or `0b1.1`), and exact 64-bit integer text is preserved. HEX/BIN show enum values numerically; DEC keeps the existing enum labels. Pointer summaries keep their target labels. Base selection does not change sampling, plotted coordinates, shared curve styles, or CSV exports. Composite rows have no base control. Press Escape or click outside to dismiss the menu.
