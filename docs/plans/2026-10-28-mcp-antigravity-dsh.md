# Antigravity and DeepSeek Harness MCP Implementation Plan

**Goal:** Offer ready-to-use Antigravity JSON and DeepSeek Harness YAML patch configurations from the existing MCP client picker.

**Architecture:** Keep the existing stdio server and Bridge contracts. Add named client profiles that reuse the stable runtime launcher, carry the primary workspace through `EMBERPROBE_WORKSPACE`, and set bounded client timeouts for long operations. Configuration is copied with client-specific setup instructions, following the existing rule that EmberProbe does not write client configuration files.

**Tech Stack:** CommonJS JavaScript, VS Code APIs, Node assert, the existing development-only YAML parser.

## Design choices

- Use named configuration exports: compatible with both clients and preserves their configuration ownership.
- Direct configuration-file merging would need separate handling for existing entries, client versions and DSH profiles; defer it.
- Do not invent CLI commands or registration APIs that the client documentation does not provide.
- Antigravity uses `mcpServers` JSON and `timeoutSeconds`; DSH uses an `insert` YAML patch with `@deepseek-ai/dsh-mcp-client`, `transport: stdio` and `toolCallTimeoutMs`.
- Keep the workspace path explicit because external clients may not advertise MCP roots. Do not bind exported configurations to an ephemeral Bridge instance or include tokens.
- Keep client limitations visible: DSH MCP prompts are unavailable; clients without elicitation use the existing explicit chat-confirmation fallback.

## Implementation

1. Extend `test/mcp-registration.test.js` with JSON/YAML parse checks, workspace and timeout assertions, escaping, platform coverage and picker/install flow. Keep existing cancellation coverage. Add generated-configuration stdio startup, tool discovery and read-only Bridge calls in `test/mcp-server.test.js`. Use the existing test registration.
2. Extend `src/services/mcpRegistration.js` with both clients, client-specific configuration exports and completion instructions. Preserve Claude Code, Codex, Cursor and generic JSON behavior.
3. Add Chinese and English labels and setup guidance in `src/i18n/zh.js` and `src/i18n/en.js`.
4. Update `docs/MCP.md` and the bilingual Unreleased changelog with setup instructions, long-call behavior and honest validation status. Do not modify README files.
5. Run focused MCP tests, then `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`. Record unrelated failures separately and inspect the final diff.

## References and validation boundaries

- Antigravity: https://antigravity.google/docs/mcp
- DSH client: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
- DSH patch example: https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/examples/mcp-memory/mcp-reference-memory.cordis.yml

Preserve existing uncommitted work. Automated tests establish generated configuration and MCP behavior, not interactive client or real-board validation. No hardware operation, release or commit is requested.

## Validation results

- Passed: `mcp-registration`, `mcp-server`, `mcp-tools`, `mcp-prompts` and `bridge-locator` tests, including generated JSON/YAML configurations launching a real stdio process without client roots and calling a local test Bridge.
- Passed: ESLint and Prettier checks on all files changed for this adaptation; JavaScript type checking and `git diff --check`.
- Passed: `npm run bundle` outside the filesystem sandbox, which otherwise prevents esbuild from reading parent directories.
- Passed: `npm run test:e2e`, using a project-local temporary directory after the system Temp directory rejected fixture creation.
- Full `npm run check` and coverage were attempted. Unrelated runtime edits changed during execution; an initial three runtime failures passed on focused rerun, while a later full check stopped because the existing test group still referenced a renamed `cortex-debug-integration.test.js`.
- `npm run quality` passed ESLint but stopped on formatting in unrelated `src/services/runtimeObjectReader.js` and `skills/_emberprobe/agent-client.js`. These files were left untouched by this adaptation.
- Interactive Antigravity/DSH validation and hardware validation remain pending.
