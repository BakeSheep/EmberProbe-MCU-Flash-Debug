"use strict";

// Regenerates the self-hosted font subsets from the characters the site uses. Run it after changing Chinese copy;
// test/website.test.js fails when a character is missing from the subset.
//
//   FONTS=<folder with NotoSansSC-VF.ttf, Inter.ttf, JetBrainsMono.ttf> node website/capture/fonts.js
//
// Needs Python with fonttools and brotli.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { content } = require("../content");
const { chapters } = require("../tour-data");

const output = path.join(__dirname, "../assets/fonts");
// What the subset was built from: test/website.test.js compares the pages against it.
const covered = path.join(__dirname, "font-characters.txt");
const LATIN = "U+0020-007E,U+00A0,U+00B7,U+00D7,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2026,U+2192,U+2197";

function strings(value) {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
}

// Everything outside ASCII that the Chinese page shows.
function cjkText() {
    const text = [content.zh, content.en, chapters].flatMap(strings).join("");
    return [...new Set(text)].filter((character) => character.codePointAt(0) > 0x7e).join("");
}

function python(args) {
    const result = spawnSync("python", ["-m", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
}

function build(source, name, weights, selection) {
    const temporary = path.join(os.tmpdir(), `emberprobe-${name}.ttf`);
    const file = path.join(output, `${name}.woff2`);
    python(["fontTools.varLib.instancer", source, `wght=${weights}`, "-o", temporary, "-q"]);
    python([
        "fontTools.subset",
        temporary,
        ...selection,
        "--flavor=woff2",
        "--layout-features=*",
        `--output-file=${file}`
    ]);
    fs.rmSync(temporary, { force: true });
    console.log(`${name}.woff2: ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

function main() {
    const fonts = process.env.FONTS;
    if (!fonts) throw new Error("Set FONTS to the folder holding the source fonts");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(covered, cjkText());
    build(path.join(fonts, "NotoSansSC-VF.ttf"), "noto-sans-sc", "400:600", [`--text-file=${covered}`]);
    build(path.join(fonts, "Inter.ttf"), "inter", "400:600", [`--unicodes=${LATIN}`]);
    build(path.join(fonts, "JetBrainsMono.ttf"), "jetbrains-mono", "400:600", [`--unicodes=${LATIN}`]);
}

if (require.main === module) main();
module.exports = { cjkText, covered };
