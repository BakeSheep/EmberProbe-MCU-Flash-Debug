# Variable Card Notices Implementation Plan

**Goal:** Show variable-specific messages at the bottom of their sidebar and Live Watch cards using the shared four-level notice UI.

**Architecture:** A shared runtime notice scope routes messages from nested member renderers to the owning variable footer. Existing notice areas render all severity icons, text and actions. State-driven messages are replaced on refresh and cannot be dismissed while their condition persists.

**Tech Stack:** CommonJS JavaScript, existing Webview notice component and CSS, Node assert and jsdom tests.

## Implementation

1. Add scoped variable notice helpers to `src/webview/runtime.js`; expose the rendered node from the existing notice area so callers can attach action identity and accessibility metadata without duplicating its UI.
2. Migrate layout expansion, hidden-member and array-page messages to shared notices. Preserve original symbol paths, loading locks, stale-generation checks and action behavior.
3. Route static and runtime notes from both renderers to card footers. Localize pointer failure reasons and assign information, warning and error levels. Keep footer state correct when sampling updates the member tree or the card is collapsed.
4. Remove superseded note/action styling; keep shared notice styles and add only footer placement rules.
5. Add focused coverage in `test/variable-card-notices.test.js` and register it in `scripts/test-groups.js`. Update existing interaction assertions for the shared markup.
6. Verify focused DOM tests, then `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Capture and inspect a rendered fixture for narrow cards. No hardware operations are needed.

## Severity

- Information: waiting for samples, collapsed sampling, hidden internal members, array pagination, read-only guidance and null pointers.
- Warning: partial layouts, depth/expansion limits, unresolved layout positions, opaque targets and stale ELF handles.
- Error: invalid type cycles, failed member loads, inaccessible memory and invalid pointer targets.
- Success: supported by the reused component; no persistent success is invented for ordinary sample refreshes.

## Validation boundaries

Keep the prior uncommitted slider and readable-name fixes. Do not change symbol identity, sampling authorization, memory budgets or hardware behavior. This task does not request a commit.
