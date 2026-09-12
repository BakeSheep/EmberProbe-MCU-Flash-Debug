"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseProperties } = require("../src/services/javaProperties");
const { parseIoc } = require("../src/services/cubemxProject");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/cubemx/H750_ExtensionTest.ioc"), "utf8");
const project = parseIoc(fixture);
assert.strictEqual(project["PA13 (JTMS/SWDIO).Mode"], "Serial_Wire");
assert.strictEqual(project["PH0-OSC_IN (PH0).Mode"], "HSE-External-Oscillator");
assert.strictEqual(project["ProjectManager.UnderRoot"], "false");
const values = parseProperties(
    "\uFEFF# comment\r\n !comment\na\\ b\\:c\\=d : hello\\\n  world\nname=\\u4e2d\\u6587\nescaped=\\t\\n\\r\\f\\\\\\z\nempty\nkey value\nlast=tail\\"
);
assert.strictEqual(values["a b:c=d"], "helloworld");
assert.strictEqual(values.name, "中文");
assert.strictEqual(values.escaped, "\t\n\r\f\\z");
assert.strictEqual(values.empty, "");
assert.strictEqual(values.key, "value");
assert.strictEqual(values.last, "tail");
assert.throws(
    () => parseProperties("ok=1\nwrong=\\u12xz"),
    (error) => error.details.line === 2 && error.code === "CUBEMX_IOC_INVALID"
);
assert.throws(
    () => parseProperties("a=1\n\\u0061=2"),
    (error) => error.details.line === 2
);
// Validate decoded values: escaping must not conceal external paths or hooks.
assert.throws(
    () => parseIoc(fixture.replace("ProjectManager.UAScriptBeforePath=", "ProjectManager.UAScriptBeforePath=run.cmd")),
    /hooks/
);
assert.throws(
    () =>
        parseIoc(
            fixture.replace("ProjectManager.ToolChainLocation=", "ProjectManager.ToolChainLocation=\\u002e\\u002e/out")
        ),
    /External/
);
console.log("Real CubeMX fixture and Java Properties parsing tests passed");
