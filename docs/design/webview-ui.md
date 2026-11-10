# Webview UI design

User behavior is in [Waveform panels](../guide/waveform.md#波形窗口) and [Webview wheel zoom](../guide/settings.md#页面滚轮缩放).

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

## Waveform viewports

`chartViewportController.js` owns canvas gestures, fit actions and a panel-local stack of at most 20 viewport snapshots. It receives the clock and coordinate conversion from its environment. Snapshots retain X/Y ranges, fit/follow modes, exact-integer axis origin and time-window selection; they never retain samples. Wheel bursts within 250 ms form one undo step. Raw/normalized mode switches and snapshot lifecycle changes clear incompatible undo entries.

Plot following uses eight plot pixels of the visible time span as its edge tolerance. Timeline handles use eight timeline pixels of the full session instead. Pointer motion below three pixels does not mutate the viewport; horizontal gestures preserve automatic Y. Page zoom captures its own modifier gestures before chart handlers.

`viewport.visibleRange` clips continuous neighbouring segments at viewport edges, preserving explicit null gaps and the raw sample count. This prevents empty charts between sparse samples and excludes offscreen extremes from Y fitting. Exact integer offsets are applied before clipping. `chart.js` fits committed display statistics, including display gain, with either 40% centered occupancy or the existing 8% data padding. Automatic fitting expands immediately and delays substantial contraction for one second using the frame clock; explicit fits apply immediately. Pending contraction keeps drawing without requiring new samples. Original and normalized Y state remain separate, and normalized fitting uses its 0–1 scale.

Regression coverage is in `test/chart-webview.test.js`; simulated histories and injected clocks require no probe.

The timeline's right-hand split button replaces the separate Auto Y toggle. The main surface maps left/right to one-shot/automatic and short/long to centered/filled fitting. An injected browser clock schedules the 500 ms threshold; a fired hold cannot emit a second action on release or the following compatibility click. Pointer cancellation, capture loss, movement, window blur, hidden documents and lost display data cancel pending holds. Keyboard/assistive clicks center once, and a separate upward arrow keeps all four actions keyboard-accessible in a menu anchored above the timeline. Press state lives on the panel's chart state. Chinese and English option labels have equal character counts within each language.

## Page zoom

`src/webview/pageZoom.js` owns shared zoom state and conversion between viewport and layout coordinates. The host returns settings through the shared message routes and broadcasts configuration changes; a focused page requests the current setting again. Waveform hit testing, panel resizing, popup placement, card reordering and export selection use the same coordinate conversions. The waveform canvas also adjusts its backing resolution for page zoom. Viewport CSS variables and container queries keep the layout inside the page and responsive to its effective width.

Software validation uses `test/webview-zoom.test.js` and the existing Webview/layout tests. Browser mockup checks use simulated samples and do not establish hardware behavior.

## Background icon

Only the cropped alpha mask, at most 512 pixels on its longest side, is stored; transparent margins are trimmed first. Background removal treats only regions connected to the image boundary as background.
