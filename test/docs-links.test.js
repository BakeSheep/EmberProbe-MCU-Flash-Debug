"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function walk(directory, accept, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file, accept, files);
        else if (accept(file)) files.push(file);
    }
    return files;
}

const stripCode = (text) => text.replace(/^```[\s\S]*?^```/gmu, "");
const headingSlug = (heading) =>
    heading
        .replace(/[`*]/gu, "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/gu, "-");

function anchorsOf(file) {
    const headings = stripCode(fs.readFileSync(file, "utf8")).match(/^#{1,6} .+$/gmu) || [];
    return new Set(headings.map((line) => headingSlug(line.replace(/^#+ /u, ""))));
}

const isMarkdown = (file) => file.endsWith(".md");
const markdown = [
    ...walk(path.join(root, "docs"), isMarkdown),
    ...["README.md", "README_EN.md", "native/openocd/README.md", "test/hil/README.md"].map((file) =>
        path.join(root, file)
    )
];

for (const file of markdown) {
    const label = path.relative(root, file);
    for (const [, link] of stripCode(fs.readFileSync(file, "utf8")).matchAll(/\]\(([^)\s]+)\)/gu)) {
        if (/^[a-z][a-z0-9+.-]*:/iu.test(link)) continue;
        const [target, anchor] = link.split("#");
        const resolved = target ? path.resolve(path.dirname(file), target) : file;
        assert.ok(fs.existsSync(resolved), `${label} links to missing ${link}`);
        if (anchor && resolved.endsWith(".md")) {
            assert.ok(anchorsOf(resolved).has(anchor), `${label} links to missing heading ${link}`);
        }
    }
}

// Plain-text paths in project instructions, skills, sources and the manifest.
const plainText = [
    ...["AGENTS.md", "CLAUDE.md", "THIRD_PARTY_NOTICES.md", "package.json"].map((file) => path.join(root, file)),
    ...walk(path.join(root, "skills"), isMarkdown),
    ...walk(path.join(root, "src"), (file) => file.endsWith(".js"))
];
for (const file of plainText) {
    for (const [reference] of fs.readFileSync(file, "utf8").matchAll(/(?<![\w/.-])docs\/[\w./-]+\.(?:md|png|gif)/gu)) {
        assert.ok(fs.existsSync(path.join(root, reference)), `${path.relative(root, file)} names missing ${reference}`);
    }
}

// Pages stay grouped by reader.
const allowedRoots = new Set(["README.en.md", "README.md", "design", "development", "guide", "images", "records"]);
for (const entry of fs.readdirSync(path.join(root, "docs"))) {
    assert.ok(allowedRoots.has(entry), `docs/${entry} belongs in a reader directory`);
}

// Every user page exists in both languages.
const guide = path.join(root, "docs", "guide");
for (const entry of fs.readdirSync(guide, { recursive: true })) {
    const name = String(entry);
    if (!name.endsWith(".md")) continue;
    const page = path.join(guide, name);
    const counterpart = name.endsWith(".en.md") ? page.replace(/\.en\.md$/, ".md") : page.replace(/\.md$/, ".en.md");
    assert.ok(fs.existsSync(counterpart), `docs/guide/${name} has no counterpart in the other language`);
}

console.log("Docs link tests passed");
