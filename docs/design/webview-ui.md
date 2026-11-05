# Webview UI design

User behavior is in [Waveform panels](../guide/variables/waveform.en.md) and [Webview wheel zoom](../guide/webview-zoom.en.md).

## Waveform panel persistence


Each waveform has a display number and a separate stable watch-list storage key. Renumbering a restored tab never selects another chart's variables, curve visibility, runtime expansions, or sampling/history scope.

VS Code restores hidden Webviews when they first become visible. Panel allocation therefore checks both registered panels and all EmberProbe Webview tabs in `window.tabGroups`, including tabs that have not been deserialized. It recognizes Chinese and English titles, and ignores other extensions' tabs.

The renderer saves `panelId` and `watchKey` through `setState()` at startup and on subsequent UI changes. `liveWatch.panelBindings` in workspace state reserves the storage identities of hidden tabs across restarts. Registry writes finish before a panel handles its messages and are flushed during extension shutdown.

### Compatibility


- Existing `mcu.watchList` and `mcu.watchList.N` keys remain valid. No workspace-wide migration is required.
- Older serialized tabs with a panel number recover their original storage identity. Without a saved number, the localized tab title identifies the legacy chart.
- A display-number conflict only changes the label. If the original storage identity is already owned by another tab, the restored chart gets an independent copy of its watches, curve visibility, and runtime expansions under a UUID-suffixed watch key. Samples and history remain independent.
- A legacy tab with neither a usable saved identity nor a recognizable title opens with an empty independent list. Its old workspace lists are preserved.
- Closing a tab releases its display number. Late messages from the disposed Webview cannot modify a replacement tab.

The regression cases are in the panel identity section of `test/chart-host.test.js`. The Extension Host smoke test also uses a real hidden, unregistered Webview tab to verify allocation against VS Code's tab inventory.

## Curve style allocation

Automatic allocation is local to each panel and reconstructed on restore. Styles are allocated when a scalar curve is first enabled, never eagerly from saved watch lists. Manual overrides are saved in the workspace and reserve automatic combinations in panels where that variable's curve has been enabled, including while hidden. Existing saved styles are retained because older records do not distinguish manual and automatic selections.

## Page zoom

`src/webview/pageZoom.js` owns shared zoom state and conversion between viewport and layout coordinates. The host returns settings through the shared message routes and broadcasts configuration changes; a focused page requests the current setting again. Waveform hit testing, panel resizing, popup placement, card reordering and export selection use the same coordinate conversions. The waveform canvas also adjusts its backing resolution for page zoom. Viewport CSS variables and container queries keep the layout inside the page and responsive to its effective width.

Software validation uses `test/webview-zoom.test.js` and the existing Webview/layout tests. Browser mockup checks use simulated samples and do not establish hardware behavior.

## Background icon

Only the cropped alpha mask, at most 512 pixels on its longest side, is stored; transparent margins are trimmed first. Background removal treats only regions connected to the image boundary as background.
