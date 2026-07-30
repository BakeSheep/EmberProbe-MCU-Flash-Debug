# EmberProbe P0 Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete every remaining P0 engineering task in `ROADMAP.md`, with hardware execution represented by a ready-to-connect self-hosted runner workflow.

**Architecture:** Replace mutable probe flags with exclusive leases and phase transitions. Extract configuration, flash, fault, and Agent Bridge boundaries into testable services. Preserve the existing Webview generators while externalizing their generated CSS and JavaScript into hashed global-storage assets protected by nonce CSP.

**Tech Stack:** Node.js CommonJS, VS Code extension APIs, OpenOCD Tcl-RPC, ESLint, Prettier, TypeScript checkJs, c8, @vscode/test-electron, GitHub Actions.

---

### Task 1: Release preparation automation

**Files:**
- Create: `scripts/release.js`
- Create: `test/release-script.test.js`
- Modify: `package.json`

**Steps:**
1. Test semantic-version validation and updates to package files, READMEs, and Changelog fixtures.
2. Implement an idempotent `release:prepare` command.
3. Verify a dry-run reports intended changes without touching the repository.

### Task 2: Exclusive probe leases

**Files:**
- Modify: `src/probeCoordinator.js`
- Modify: `src/extension.js`
- Modify: `test/probe-coordinator.test.js`

**Steps:**
1. Add failing tests for acquisition, conflict diagnostics, transition, idempotent release, and stale leases.
2. Implement lease tokens and `liveStart -> liveWatch` transition.
3. Route all existing operation-state setters through stored leases.
4. Run coordinator, live-watch, write, and Webview tests.

### Task 3: Service boundaries

**Files:**
- Create: `src/services/configurationStore.js`
- Create: `src/services/flashService.js`
- Create: `src/services/faultService.js`
- Create: `src/services/agentService.js`
- Create: `test/services.test.js`
- Modify: `src/extension.js`

**Steps:**
1. Test each service with injected dependencies.
2. Move configuration validation/update, flash execution, fault decoding/symbolization, and Agent Bridge lifecycle/routing into services.
3. Keep UI status and probe coordination in `MainViewProvider`.
4. Run all existing behavioral tests.

### Task 4: External Webview assets and CSP

**Files:**
- Create: `src/webviewAssets.js`
- Create: `test/webview-assets.test.js`
- Modify: `src/extension.js`
- Modify: `test/webview.test.js`

**Steps:**
1. Test that generated HTML contains no inline style/script and no `unsafe-inline`.
2. Extract inline blocks into content-addressed files under extension global storage.
3. Replace blocks with Webview URIs and nonce-bearing tags.
4. Permit only the Webview CSP source and nonce.

### Task 5: Extension Host smoke tests

**Files:**
- Create: `test/e2e/runTest.js`
- Create: `test/e2e/suite/index.js`
- Create: `test/e2e/fixtures/.gitkeep`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Steps:**
1. Launch VS Code with this repository as the development extension.
2. Activate EmberProbe and assert its contributed commands exist.
3. Run the smoke test on Ubuntu under Xvfb in CI.

### Task 6: Hardware-in-the-loop matrix

**Files:**
- Create: `test/hil/run-hil.js`
- Create: `test/hil/README.md`
- Create: `.github/workflows/hil.yml`

**Steps:**
1. Validate required board, OpenOCD, probe, target, and ELF inputs.
2. Execute OpenOCD program/verify/reset with a bounded timeout.
3. Configure STM32F1, STM32F4, nRF52, and RP2040 self-hosted runner jobs.
4. Document runner labels, variables, safety, and manual invocation.

### Task 7: Quality gates

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `jsconfig.quality.json`
- Create: `scripts/run-tests.js`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Steps:**
1. Add lint, format, scoped checkJs, and coverage scripts.
2. Set an initial enforceable coverage floor for the new P0 modules.
3. Run quality gates in cross-platform CI.
4. Keep the existing full regression command unchanged in coverage semantics.

### Task 8: Roadmap and final verification

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

**Steps:**
1. Mark implemented P0 tasks complete and identify the external HIL runner prerequisite.
2. Run `npm run check`, `npm run quality`, `npm run bundle`, and the Extension Host smoke test.
3. Run `git diff --check` and inspect the final worktree without modifying `.claude/`.
