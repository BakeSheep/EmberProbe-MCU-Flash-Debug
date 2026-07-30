"use strict";
const fs = require("fs");
const path = require("path");

const VERSION_RE =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validateVersion(value) {
    const version = String(value || "").trim();
    if (!VERSION_RE.test(version)) {
        throw Object.assign(new Error(`Invalid semantic version: ${value || "(empty)"}`), {
            code: "INVALID_VERSION"
        });
    }
    return version;
}

function replaceVersionLine(text, pattern, version, file) {
    if (!pattern.test(text)) {
        throw Object.assign(new Error(`Could not find the version marker in ${file}`), {
            code: "VERSION_MARKER_MISSING",
            file
        });
    }
    return text.replace(pattern, (match) => match.replace(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, version));
}

function prepareRelease(root, nextVersion, options = {}) {
    const version = validateVersion(nextVersion);
    const date = String(options.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw Object.assign(new Error(`Invalid release date: ${date}`), { code: "INVALID_RELEASE_DATE" });
    }

    const files = new Map();
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
    const add = (file, content) => files.set(file, content);

    const pkg = JSON.parse(read("package.json"));
    pkg.version = version;
    add("package.json", JSON.stringify(pkg, null, 2) + "\n");

    const lock = JSON.parse(read("package-lock.json"));
    lock.version = version;
    if (!lock.packages || !lock.packages[""]) {
        throw Object.assign(new Error("package-lock.json has no root package"), { code: "LOCK_ROOT_MISSING" });
    }
    lock.packages[""].version = version;
    add("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

    add(
        "README.md",
        replaceVersionLine(
            read("README.md"),
            /当前扩展版本为 `\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`/,
            version,
            "README.md"
        )
    );
    add(
        "README_EN.md",
        replaceVersionLine(
            read("README_EN.md"),
            /current extension version is `\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`/i,
            version,
            "README_EN.md"
        )
    );

    const changelog = read("CHANGELOG.md");
    if (changelog.includes(`## [${version}]`)) {
        throw Object.assign(new Error(`CHANGELOG already contains ${version}`), { code: "VERSION_EXISTS" });
    }
    const unreleased = changelog.match(/## \[Unreleased\]\s*([\s\S]*?)(?=\n## \[)/);
    if (!unreleased) {
        throw Object.assign(new Error("CHANGELOG has no Unreleased section"), { code: "UNRELEASED_MISSING" });
    }
    const notes = unreleased[1].trim();
    if (!notes) {
        throw Object.assign(new Error("CHANGELOG Unreleased section is empty"), { code: "UNRELEASED_EMPTY" });
    }
    const releaseBlock = `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n`;
    add("CHANGELOG.md", changelog.replace(/## \[Unreleased\]\s*[\s\S]*?(?=\n## \[)/, releaseBlock));

    const changed = [];
    for (const [file, content] of files) {
        const current = read(file);
        if (current === content) continue;
        changed.push(file);
        if (!options.dryRun) fs.writeFileSync(path.join(root, file), content);
    }
    return { version, date, dryRun: !!options.dryRun, changed };
}

function parseCli(argv) {
    const args = argv.slice();
    const version = args.shift();
    let date;
    let dryRun = false;
    while (args.length) {
        const arg = args.shift();
        if (arg === "--dry-run") dryRun = true;
        else if (arg === "--date") date = args.shift();
        else throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: "UNKNOWN_ARGUMENT" });
    }
    return { version, date, dryRun };
}

if (require.main === module) {
    try {
        const args = parseCli(process.argv.slice(2));
        const result = prepareRelease(path.resolve(__dirname, ".."), args.version, args);
        console.log(
            `${result.dryRun ? "Would update" : "Updated"} ${result.changed.join(", ")} for ${result.version} (${result.date})`
        );
    } catch (error) {
        console.error(`${error.code || "RELEASE_ERROR"}: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { validateVersion, prepareRelease, parseCli };
