# Settings Cleanup Implementation Plan

**Goal:** Remove memory region overrides and configurable MCP toolsets; always expose every MCP tool.

**Architecture:** Keep automatic memory classification in the analysis module. Use the complete tool and prompt catalogs directly in the MCP server and remove toolset configuration from registration.

**Tech Stack:** ES2022 CommonJS, VS Code configuration, Node.js assert tests.

1. Remove the memory and MCP configuration groups from `package.json`; update manifest coverage in `test/configuration-store.test.js`.
2. Remove memory override injection, validation and refresh listeners from `src/services/memoryAnalysisController.js` and `memoryAnalysisService.js`; simplify `src/memoryAnalysis.js` and update its existing tests and bilingual unknown-region text.
3. Remove MCP filtering helpers from `src/mcp/tools.js` and `prompts.js`; expose both catalogs directly in `server.js`. Remove configuration forwarding from the Provider, composition root, extension listener and `mcpRegistration.js`.
4. Update existing MCP catalog, prompt, registration, access and server scenarios, including legacy environment values that must not restrict tools or prompts.
5. Update `docs/SETTINGS.md`, `docs/MCP.md` and the bilingual Unreleased changelog. Preserve unrelated edits and leave README files unchanged.
6. Run affected tests, `npm run check`, `npm run quality`, `npm run bundle` and `npm run test:e2e`; inspect the final diff and report any pre-existing failures.
