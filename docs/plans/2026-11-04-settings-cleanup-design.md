# VS Code settings cleanup

The requested change removes five public settings and organizes the remaining 23 settings into eight ordered groups with Chinese and English descriptions. The manifest remains the source of truth; default values, scopes and validation ranges of retained settings stay intact.

Remove runtime reads of `probeSerial`, `sampleIntervalMs`, `enablePrettyPrinting` and `prettyPrinterPath`. Sidebar selection owns the workspace probe choice. Internal physical connection identities and explicit standalone flash serial arguments remain available. Remove obsolete Agent configuration writes and MCP schema keys, plus the sampling compatibility registry entries.

Implementation sequence:

1. Group and translate manifest settings; remove obsolete launch/attach display aliases.
2. Remove obsolete runtime fallbacks and setting-based sidebar locks.
3. Update existing configuration, sampling, probe, C++ and Extension Host tests; document settings and migration.
4. Run focused tests, `npm run check`, `npm run quality`, `npm run bundle`, Extension Host smoke tests and relevant native GDB tests where supported.

Validation uses local fixtures and software toolchains. No real-board operations, driver changes, firmware programming or release publication are part of this change. Preserve existing uncommitted work, including README changes.
