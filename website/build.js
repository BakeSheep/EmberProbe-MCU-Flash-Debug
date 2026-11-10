"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { home, demoPage, origin } = require("./template");
const { version } = require("../package.json");
const root = path.resolve(__dirname, "..");
const output = path.join(__dirname, "dist");

function buildSite() {
    execFileSync(process.execPath, [path.join(root, "mockup/build.js")], { cwd: root, stdio: "pipe" });
    // Only the website's fixed generated directory is replaced; never touch the extension's dist.
    if (path.relative(root, output) !== path.join("website", "dist")) throw new Error("Unexpected site output");
    fs.rmSync(output, { recursive: true, force: true });
    fs.mkdirSync(path.join(output, "assets"), { recursive: true });
    fs.mkdirSync(path.join(output, "en"), { recursive: true });
    fs.mkdirSync(path.join(output, "demo"), { recursive: true });
    fs.cpSync(path.join(root, "mockup/dist"), path.join(output, "demo/editor"), { recursive: true });
    fs.cpSync(path.join(__dirname, "assets"), path.join(output, "assets"), { recursive: true });
    for (const name of ["site.css", "site.js", "motion.js", "tour-data.js", "demo.js"])
        fs.copyFileSync(path.join(__dirname, name), path.join(output, "assets", name));
    for (const lang of ["zh", "en"])
        fs.writeFileSync(path.join(output, lang === "en" ? "en/index.html" : "index.html"), home(lang, version));
    fs.writeFileSync(path.join(output, "demo/index.html"), demoPage());
    fs.writeFileSync(path.join(output, ".nojekyll"), "");
    fs.writeFileSync(path.join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}sitemap.xml\n`);
    fs.writeFileSync(
        path.join(output, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}</loc></url><url><loc>${origin}en/</loc></url></urlset>\n`
    );
    const credits = [
        "EmberProbe website — MIT. Recordings: EmberProbe mockup, simulated data, not hardware measurements.",
        "The editor shell approximates VS Code and is not affiliated with Microsoft.",
        fs.readFileSync(path.join(root, "mockup/vendor/README.md"), "utf8")
    ];
    for (const file of ["LICENSE-CODE", "LICENSE-ICONS", "LICENSE-VSCODE", "SETI-NOTICES.txt"])
        credits.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(root, "mockup/vendor", file), "utf8")}`);
    const licenses = path.join(__dirname, "capture/font-licenses");
    for (const file of fs.readdirSync(licenses).sort())
        credits.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(licenses, file), "utf8")}`);
    fs.writeFileSync(path.join(output, "credits.txt"), credits.join("\n\n"));
    return output;
}

if (require.main === module) console.log(`Website built: ${buildSite()}`);
module.exports = { buildSite, output };
