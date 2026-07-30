# EmberProbe P0 Productization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the first productization increment: consistent release metadata, centralized probe state, and repeatable CI/integration tests.

**Architecture:** Keep the existing extension behavior intact while extracting probe-operation state into a pure JavaScript coordinator. Add repository-level consistency checks and a loopback Fake OpenOCD Tcl server so the highest-risk protocol path can be tested without hardware.

**Tech Stack:** Node.js CommonJS, VS Code extension APIs, OpenOCD Tcl-RPC, GitHub Actions.

---

### Task 1: Publish the roadmap

**Files:**
- Create: `ROADMAP.md`
- Create: `docs/plans/2026-07-30-p0-productization.md`

**Steps:**
1. Record the 0.5, 0.6, 0.7 and 1.0 milestones.
2. Mark only changes implemented in this iteration as complete.
3. Verify both Markdown files are included by `rg --files`.

### Task 2: Make 0.4.9 release metadata consistent

**Files:**
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `package.json`
- Create: `test/release-consistency.test.js`

**Steps:**
1. Write a release-consistency test for package/lock versions, Changelog, both READMEs, and all manifest Skills.
2. Run `node test/release-consistency.test.js` and confirm it fails on the existing drift.
3. Update the metadata and documentation to version 0.4.9.
4. Add the test to `npm run check`.
5. Run the test again and confirm it passes.

### Task 3: Extract probe operation state

**Files:**
- Create: `src/probeCoordinator.js`
- Create: `test/probe-coordinator.test.js`
- Modify: `src/extension.js`
- Modify: `package.json`

**Steps:**
1. Write tests for valid state transitions, snapshots, active-operation lookup, and invalid operation names.
2. Implement `ProbeCoordinator` as a VS Code-independent module.
3. Replace `MainViewProvider`'s state fields with coordinator-backed compatibility accessors.
4. Run `node test/probe-coordinator.test.js`.
5. Run existing Webview and authorization tests to detect behavior changes.

### Task 4: Add Tcl-RPC integration coverage

**Files:**
- Create: `test/helpers/fake-openocd-server.js`
- Create: `test/live-watch-integration.test.js`
- Modify: `package.json`

**Steps:**
1. Start a loopback Tcl server on an ephemeral port.
2. Attach `LiveWatchSession` to it without spawning OpenOCD.
3. Verify contiguous reads are merged and decoded into separate variable samples.
4. Verify a write command reaches the server with the correct address and bytes.
5. Stop the session and server without leaking sockets.

### Task 5: Add cross-platform CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Steps:**
1. Configure Node.js 20 on Windows, Ubuntu, and macOS.
2. Run `npm ci`, `npm run check`, and `npm run bundle`.
3. Keep packaging/release publication outside pull-request CI.
4. Validate the workflow file is present and the full local check passes.

### Task 6: Final verification

**Steps:**
1. Run `npm run check`.
2. Run `npm run bundle`.
3. Run `git diff --check`.
4. Inspect `git status --short` and preserve unrelated `.claude/` files.
