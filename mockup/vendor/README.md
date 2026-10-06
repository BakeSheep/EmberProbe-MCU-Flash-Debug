# VS Code resources

These resources were taken from the matching VS Code 1.136.1 Extension Host test installation. They are committed snapshots; generating the demo does not require that installation, a CDN or a network connection.

- `codicon.css` and `codicon.ttf`: the official Codicon definitions and matching embedded font from `extensions/simple-browser/media/codicon.css`. The font was extracted unchanged and only its CSS URL was changed to a local file. Sources: [Microsoft Codicons](https://github.com/microsoft/vscode-codicons), [product icon reference](https://code.visualstudio.com/api/references/icons-in-labels). Icons/content use CC BY 4.0 (`LICENSE-ICONS`); code uses MIT (`LICENSE-CODE`).
- `vscode-logo.svg`: the unchanged official VS Code ribbon from `out/vs/workbench/browser/media/code-icon.svg`. Used solely to identify the simulated VS Code window. Visual Studio Code and its icon are Microsoft trademarks; see [brand guidelines](https://code.visualstudio.com/brand). EmberProbe is an independent project.
- `dark-modern-colors.json` and `light-modern-colors.json`: merged `theme-defaults/themes/*_modern.json` colors, including their `*_plus.json` and `*_vs.json` parents, from [Microsoft VS Code](https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes). MIT (`LICENSE-VSCODE`).
- `seti.woff` and `seti.css`: the matching Seti file icon font and C/header/Markdown/JSON definitions from `theme-seti/icons/vs-seti-icon-theme.json`; both theme colors are preserved. Attribution and licenses are in `SETI-NOTICES.txt`.

The demo's layout follows the Windows workbench with the classic activity bar and Modern themes. It demonstrates extension interfaces and does not implement the VS Code editor or all workbench commands.
