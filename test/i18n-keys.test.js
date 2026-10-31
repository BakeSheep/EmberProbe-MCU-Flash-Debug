"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { STRINGS } = require("../src/i18n");
const { scenario } = require("./helpers/scenario");

// The extension looks keys up in src; the shared skill modules carry them as reasonKey/i18nKey fields.
const ROOT = path.join(__dirname, "..");
const TABLES = path.join(ROOT, "src", "i18n");
const KEY = String.raw`[A-Za-z]\w*(?:\.[\w-]+)+`;
const PREFIX = String.raw`[A-Za-z]\w*(?:\.\w+)*\.`;

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return file === TABLES ? [] : sourceFiles(file);
        return entry.name.endsWith(".js") ? [file] : [];
    });
}

const sources = ["src", "skills"]
    .flatMap((directory) => sourceFiles(path.join(ROOT, directory)))
    .map((file) => ({ file: path.relative(ROOT, file).replace(/\\/g, "/"), text: fs.readFileSync(file, "utf8") }));
const keys = Object.keys(STRINGS.zh);
const namespaces = new Set(keys.map((key) => key.split(".")[0]));

scenario("both tables define the same keys", () => {
    const en = new Set(Object.keys(STRINGS.en));
    assert.deepStrictEqual(
        keys.filter((key) => !en.has(key)),
        [],
        "keys missing from en.js"
    );
    assert.deepStrictEqual(
        [...en].filter((key) => !Object.hasOwn(STRINGS.zh, key)),
        [],
        "keys missing from zh.js"
    );
});

scenario("every key is still referenced", () => {
    // A key is used when it appears as a whole quoted string (t() calls, data-i18n attributes, reasonKey fields,
    // ternaries), or when code builds it from a quoted prefix such as "err." + code or `mcp.client.${client}`.
    // Prefixes are read from the code itself, so there is no allowlist to fall out of date.
    const literals = new Set();
    const prefixes = new Set();
    for (const { text } of sources) {
        for (const match of text.matchAll(new RegExp(String.raw`\\?(["'\x60])(${KEY})\\?\1`, "g")))
            literals.add(match[2]);
        for (const match of text.matchAll(new RegExp(String.raw`(["'])(${PREFIX})\1|\x60(${PREFIX})\$\{`, "g"))) {
            const prefix = match[2] || match[3];
            if (namespaces.has(prefix.split(".")[0])) prefixes.add(prefix);
        }
    }
    const unused = keys.filter((key) => !literals.has(key) && ![...prefixes].some((prefix) => key.startsWith(prefix)));
    assert.deepStrictEqual(unused, [], "unreferenced keys; delete them from both en.js and zh.js");
});

scenario("literal lookups name existing keys", () => {
    // i18n.t falls back to the key itself, so a typo would otherwise show the raw key in the UI.
    const lookups = [
        new RegExp(String.raw`\b_?t\(\s*(?:[\w.]+\s*,\s*)?(["'])(${KEY})\1`, "g"),
        new RegExp(String.raw`data-i18n(?:-\w+)?=\\?"(?<key>${KEY})\\?"`, "g")
    ];
    const missing = [];
    for (const { file, text } of sources) {
        for (const pattern of lookups) {
            for (const match of text.matchAll(pattern)) {
                const key = match.groups?.key || match[2];
                if (!Object.hasOwn(STRINGS.zh, key) || !Object.hasOwn(STRINGS.en, key)) missing.push(`${file}: ${key}`);
            }
        }
    }
    assert.deepStrictEqual(missing, [], "lookups of keys that neither table defines");
});

console.log("i18n key tests passed");
