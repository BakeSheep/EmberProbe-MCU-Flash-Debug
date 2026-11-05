# MCP harness adapters

Goal: adapt EmberProbe's stable stdio launch specification to each supported harness, using cc-switch's format
separation as a reference. Keep the Bridge and all hardware authorization unchanged.

The final workflow uses native file adapters for Claude, Codex, Gemini, OpenCode, Antigravity and DSH. Cursor keeps its
extension API/install link, and unknown clients keep clipboard export. Native writing is an explicit command action,
with paths and generated configuration shown before commit; no client files are changed on activation.

Implementation:

1. `mcpClientConfig.js` converts the stable stdio launch spec to each client's native format, including workspace binding
   and client-specific timeout units. The existing CLI methods remain optional for Claude/Codex/Gemini.
2. `mcpConfigEdits.js` uses JSONC/TOML syntax trees and targeted YAML edits to preserve unrelated source and custom options.
   Invalid or ambiguous documents and tagged/anchored managed YAML entries fail without writing.
3. `mcpConfigFiles.js` resolves native paths and environment overrides, builds bounded snapshots, and commits with locks,
   optimistic change checks and atomic replacement. DSH updates Web/Desktop plus existing Headless/ACP profiles as one
   transaction; a later failure rolls back earlier writes without overwriting newer external edits.
4. `mcpRegistration.js` shows the preview and install/copy/optional CLI actions, reports failures without claiming success,
   and preserves existing Bridge and hardware authorization.
5. Tests cover all six file adapters, round trips, idempotence, comments, path overrides, aliases, symlinks/junctions,
   lock conflicts, concurrent edits, partial failure and rollback. Validate with check, quality, bundle and Extension Host.

References:

- [cc-switch MCP adapters](https://github.com/farion1231/cc-switch/tree/main/src-tauri/src/mcp)
- [Gemini MCP configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- [OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)

Client interaction and hardware validation remain separate from software regression tests. No HIL or user-client
configuration changes are part of implementing these adapters.
