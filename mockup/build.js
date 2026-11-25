/*
 * Regenerates the standalone EmberProbe UI mock under mockup/dist.
 *
 * The sidebar and live-watch pages are produced by the extension's own view
 * generators (src/modernView.js, src/liveWatchView.js), so the mock stays in
 * sync with the real frontend. A small prelude provides acquireVsCodeApi and
 * forwards commands to the mock hosts in the shell page.
 *
 * Usage: node mockup/build.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");
const modernView = require("../src/modernView");
const liveWatchView = require("../src/liveWatchView");
const rttPanelView = require("../src/rttPanelView");
const { STRINGS } = require("../src/i18n");
const mockCsv = require("./mock-csv");
const mockRtt = require("./mock-rtt");
const mockMcp = require("./mock-mcp");
const configuration = require("./mock/configuration");

const root = __dirname;
const dist = path.join(root, "dist");
const shellDir = path.join(root, "shell");
const mockDir = path.join(root, "mock");

const themeCss = fs.readFileSync(path.join(mockDir, "theme.css"), "utf8");
const preludeJs = fs.readFileSync(path.join(mockDir, "prelude.js"), "utf8");
const themeJs = fs.readFileSync(path.join(mockDir, "theme.js"), "utf8");
const referenceCss = fs.readFileSync(path.join(mockDir, "reference.css"), "utf8");
const darkColors = require("./vendor/dark-modern-colors.json");
const lightColors = require("./vendor/light-modern-colors.json");

function modernThemeCss(selector, colors) {
    return (
        selector +
        " {\n" +
        Object.entries(colors)
            .map(([name, value]) => "    --vscode-" + name.replace(/\./g, "-") + ": " + value + ";")
            .join("\n") +
        "\n}\n"
    );
}

const combinedThemeCss =
    themeCss +
    modernThemeCss(":root:not([data-mock-theme=light])", darkColors) +
    modernThemeCss(":root[data-mock-theme=light]", lightColors);

const SIDEBAR_STATE = {
    versionLabel: `v${pkg.version}`,
    ...Object.fromEntries(
        Object.entries(configuration.defaults).map(([field, value]) => [field, configuration.filename(value)])
    ),
    cubemxFirmware: { packs: [configuration.firmware(configuration.defaults.iocPath)] }
};

function inject(html, page, lang) {
    const head = "<head>";
    if (!html.includes(head)) throw new Error(`Unexpected generated HTML for ${page}`);
    const injected =
        head +
        `\n<style id="mock-vscode-theme">\n${combinedThemeCss}\n</style>` +
        `\n<script id="mock-theme">\n${themeJs}\n</script>` +
        `\n<script id="mock-prelude">\n${preludeJs}\n</script>`;
    let out = html.replace(head, injected);
    out = out.replace("<body>", `<body data-mock-page="${page}" data-mock-lang="${lang}">`);
    return out.replace("</head>", `<style id="mock-reference">\n${referenceCss}\n</style></head>`);
}

function buildSidebar(lang) {
    const html = modernView
        .getModernWebviewContent(SIDEBAR_STATE, lang)
        .replace(/(<details[^>]*id="(?:memoryAnalysisSection|liveValuesSection|variableBrowser)"[^>]*?) open/g, "$1");
    return inject(html, "sidebar", lang);
}

function buildLiveWatch(lang) {
    return inject(
        liveWatchView.getLiveWatchContent(
            {
                frequencyHz: 30,
                panelId: 1
            },
            lang
        ),
        "livewatch",
        lang
    );
}

// The bottom panel's RTT terminal (src/rttPanelView.js), mounted in the shell's panel.
function buildRttPanel(lang) {
    return inject(rttPanelView.getRttPanelContent(lang), "rttpanel", lang);
}

function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function main() {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    const historySource = fs
        .readFileSync(path.join(root, "../src/services/chartHistoryStore.js"), "utf8")
        .replace("module.exports =", "root.EmberProbeMockHistory =");
    fs.writeFileSync(path.join(dist, "chart-history.js"), "(function(root) {\n" + historySource + "\n})(window);\n");
    fs.writeFileSync(path.join(dist, "csv.js"), mockCsv.browserSource(), "utf8");
    fs.writeFileSync(path.join(dist, "rtt-formatter.js"), mockRtt.browserSource(), "utf8");
    fs.writeFileSync(path.join(dist, "mcp-catalog.js"), mockMcp.browserSource(), "utf8");
    // The extension's own strings, so the mock hosts' pickers and messages read as the extension's.
    fs.writeFileSync(
        path.join(dist, "i18n.js"),
        "window.EmberProbeMockStrings = " + JSON.stringify(STRINGS) + ";\n",
        "utf8"
    );

    for (const name of ["index.html", "shell.css", "shell.js", "shell-data.js"]) {
        copyFile(path.join(shellDir, name), path.join(dist, name));
    }
    for (const name of [
        "prelude.js",
        "theme.js",
        "text.js",
        "configuration.js",
        "sampling.js",
        "archive.js",
        "rtt-settings.js",
        "sidebar-data.js",
        "sidebar-host.js",
        "livewatch-data.js",
        "livewatch-host.js",
        "rtt-panel-host.js"
    ]) {
        copyFile(path.join(mockDir, name), path.join(dist, name));
    }
    fs.writeFileSync(path.join(dist, "theme.css"), combinedThemeCss, "utf8");
    fs.writeFileSync(path.join(dist, "reference.css"), referenceCss, "utf8");
    for (const name of ["codicon.css", "codicon.ttf", "seti.css", "seti.woff", "vscode-logo.svg"]) {
        copyFile(path.join(root, "vendor", name), path.join(dist, name));
    }

    const outputs = [];
    for (const lang of ["zh", "en"]) {
        outputs.push([`sidebar.${lang}.html`, buildSidebar(lang)]);
        outputs.push([`livewatch.${lang}.html`, buildLiveWatch(lang)]);
        outputs.push([`rtt-panel.${lang}.html`, buildRttPanel(lang)]);
    }
    for (const [name, html] of outputs) {
        fs.writeFileSync(path.join(dist, name), html, "utf8");
    }

    const sizes = outputs
        .map(([name]) => `  ${name} (${Math.round(fs.statSync(path.join(dist, name)).size / 1024)} KB)`)
        .join("\n");
    console.log(`Mock built at ${dist}\n${sizes}\nOpen mockup/dist/index.html or run: node mockup/serve.js`);
}

main();
