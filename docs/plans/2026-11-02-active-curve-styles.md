# Active curve styles implementation plan

**Goal:** Allocate automatic colors and line patterns only to enabled scalar curves, with a larger automatic pool.

**Architecture:** Keep saved styles as workspace overrides. Reconcile a panel-local active style map before rendering
its variable cards, allocating styles when a curve is first enabled and retaining those reservations while it is
hidden. Only removing a variable releases its slot. Style lookups and context menus do not allocate anything.

**Implementation:**

1. Expand the deterministic palette from 12 to 48 colors, yielding 144 color/line combinations before fallback.
   Allocate unused combinations rather than deriving line patterns from the total saved record count.
2. Reconcile active styles in the shared series-style module and call it from the waveform renderer. Keep the
   inactive preview neutral. Remove automatic style requests and eager watch-list migration from the host.
   Preserve existing stored overrides because older records cannot distinguish automatic and manual choices.
3. Cover large structure imports, hidden watches, menu previews, slot reuse, explicit overrides, multiple panels,
   restored visibility, validation and the expanded pool in the existing chart tests.
4. Document the behavior in `docs/WAVEFORM-PANELS.md`. Run focused tests, `npm run check`, `npm run quality`,
   `npm run bundle` and `npm run test:e2e`; report environment limitations separately.

No README, hardware operations, release publishing, or unrelated pending changes are part of this work.
