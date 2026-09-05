"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { discover, runFile } = require("../scripts/run-tests");
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-runner-"));
    try {
        fs.mkdirSync(path.join(root, "nested"));
        fs.writeFileSync(path.join(root, "pass.js"), 'console.log("ready");');
        fs.writeFileSync(path.join(root, "fail.js"), 'console.error("expected failure");process.exitCode=3;');
        fs.writeFileSync(path.join(root, "hang.js"), "setInterval(()=>{},1000);");
        fs.writeFileSync(path.join(root, "nested", "child.js"), "");
        assert.strictEqual(discover(root).length, 3);
        assert.strictEqual(discover(root, true).length, 4);
        const passed = await runFile(path.join(root, "pass.js"), { reportDir: root });
        assert.strictEqual(passed.code, 0);
        const failed = await runFile(path.join(root, "fail.js"), { reportDir: root });
        assert.strictEqual(failed.code, 3);
        const timed = await runFile(path.join(root, "hang.js"), { timeoutMs: 200 });
        assert.strictEqual(timed.timedOut, true);
        assert.strictEqual(timed.code, 124);
        assert.ok(
            fs
                .readdirSync(root)
                .some(
                    (file) =>
                        file.endsWith(".log") &&
                        fs.readFileSync(path.join(root, file), "utf8").includes("expected failure")
                )
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Test runner diagnostics and timeout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
