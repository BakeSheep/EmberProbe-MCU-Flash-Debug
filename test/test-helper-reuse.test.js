"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { scenario } = require("./helpers/scenario");

// Binary fixture builders live in test/helpers; a test that defines its own copy drifts from the shared one.
// Every export of the ELF builders is reserved. dwarf-tree.js also exports DIE vocabulary (node, member, pointer)
// that tests legitimately reuse as local names, so only its byte encoders are reserved.
const RESERVED = {
    "elf-fixture.js": Object.keys(require("./helpers/elf-fixture")),
    "memory-fixture.js": ["buildMemoryElf"],
    "dwarf-tree.js": ["cstr", "u32", "uleb", "leb"]
};

scenario("reserved names are still exported by their helpers", () => {
    for (const [helper, names] of Object.entries(RESERVED)) {
        const exported = require(`./helpers/${helper}`);
        for (const name of names)
            assert.strictEqual(typeof exported[name], "function", `${helper} no longer exports ${name}`);
    }
});

scenario("tests reuse the shared builders instead of redefining them", () => {
    const owners = new Map(Object.entries(RESERVED).flatMap(([helper, names]) => names.map((name) => [name, helper])));
    const names = [...owners.keys()].join("|");
    // Function declarations and function-valued bindings; `let leb = { p: 0 }` (a read cursor) is not a copy.
    const definition = new RegExp(
        String.raw`^(?:async\s+)?function\s+(${names})\s*\(|^(?:const|let|var)\s+(${names})\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)`,
        "gm"
    );
    const copies = [];
    for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.js"))) {
        for (const match of fs.readFileSync(path.join(__dirname, file), "utf8").matchAll(definition)) {
            const name = match[1] || match[2];
            copies.push(`${file}: ${name} (use test/helpers/${owners.get(name)})`);
        }
    }
    assert.deepStrictEqual(copies, [], "local copies of shared test builders");
});

console.log("Test helper reuse tests passed");
