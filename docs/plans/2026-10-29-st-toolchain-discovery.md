# ST Toolchain Discovery Implementation Plan

**Goal:** Reuse installed ST tools before asking the user to select a toolchain directory.

**Architecture:** Preserve the existing resolver and add bounded discovery of known ST installation layouts. Resolve launch/settings, the remembered directory, process PATH, refreshed PATH at startup, and ST installations in that order. Background lookup remains synchronous and never prompts or refreshes the shell environment.

**Tech Stack:** CommonJS JavaScript, Node filesystem APIs, built-in assert, VS Code configuration and workspace state.

## Tasks

1. Add isolated filesystem fixtures for ST bundles, split GDB/binutils packages, CubeCLT, and CubeIDE on Windows, Linux, and macOS. Test missing/incomplete installations and deterministic version ordering.
2. Implement fixed-depth, bounded installation discovery without executing tools, modifying settings, or searching workspace files.
3. Extend preflight tests for the requested precedence, refreshed PATH before discovery, discovery before prompting, and fallback to the existing picker. Inject discovery in tests so locally installed tools cannot change their outcome.
4. Document search order and supported locations in `docs/DEBUG-TOOLCHAIN.md`.
5. Run focused tests, `npm run check`, `npm run quality`, `npm run bundle`, and `npm run test:e2e`. Discovery does not change GDB/MI or hardware operations.

## Design choices

- Fixed known layouts cover common ST installations with predictable startup cost. A whole-disk scan would be slow, and relying only on ST extension APIs would couple discovery to another extension's activation and version.
- Validate GDB, objdump, and nm using the existing executable checks; skip incomplete installations. Prefer newer installed versions within each tool family.
- Keep explicit paths whenever they form a usable tool set. Retain the existing recovery behavior for stale settings or remembered paths.
- Do not save automatically discovered directories: each lookup can recover after ST updates or removes a bundle. User-selected directories retain the existing workspace memory.
