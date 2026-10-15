# Agent Chat Confirmation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Confirm sensitive Agent operations in the Agent conversation without a second VS Code approval dialog.

**Architecture:** Keep the existing plan-bound authorization stores as the execution gate. Remove the modal approval service and its callers. Give Flash verification its own operation-bound confirmation, so removing its dialog does not allow an unconfirmed halt/resume.

**Tech Stack:** ES2022 CommonJS, VS Code APIs, built-in Node.js assertions.

---

1. Remove modal approval hooks from variable writes, peripheral writes, Flash operations and CubeMX generation. Preserve workspace trust, probe ownership, session/stop identity, resource budgets and execution checks.
2. Bind Flash confirmation to `flash.execute` or `flash.verify`. Update `skills/mcu-flash/scripts/verify.js` to return a verification plan before execution and accept its confirmation ID only after the Agent obtains the user's answer.
3. Preserve explicit `remember` choices for variable writes and CubeMX, with the existing identity scope, 24-hour expiry and reset behavior. Retire the separate modal grant store; its old records no longer authorize operations.
4. Replace modal-specific tests with chat confirmation tests: no mutation before confirmation; wrong, reused, expired or changed-plan IDs fail; verify IDs cannot program; explicit remembered permission still works.
5. Update the shared Agent workflow, relevant skill references, CubeMX documentation and bilingual Unreleased notes. Do not edit README.md.
6. Run affected tests, then `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Keep this request limited to software implementation and verification.

The Agent must show the concrete plan and obtain the human's answer before resubmitting its ID. The Bridge validates the plan and ID; it does not independently attest that a chat answer came from a human. Skill installation and modified-skill provenance prompts are separate from operation confirmation.
