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
        const environmentTest = path.join(root, "environment.js");
        fs.writeFileSync(
            environmentTest,
            [
                'const assert = require("assert");',
                'const fs = require("fs");',
                'const os = require("os");',
                'const path = require("path");',
                "assert.strictEqual(os.tmpdir(), fs.realpathSync(os.tmpdir()));",
                "assert.strictEqual(path.dirname(os.tmpdir()), process.env.HOME);",
                "assert.strictEqual(process.env.TEMP, process.env.TMPDIR);",
                "assert.strictEqual(process.env.TMP, process.env.TMPDIR);",
                'fs.writeFileSync(path.join(os.tmpdir(), "leftover"), "fixture");',
                'console.log("TEMP_ROOT=" + os.tmpdir());'
            ].join("\n")
        );
        // Reproduce macOS-style aliases even on Windows/Linux runners.
        const alias = path.join(root, "temp-alias");
        const target = path.join(root, "temp-target");
        fs.mkdirSync(target);
        fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
        const tempKey = process.platform === "win32" ? "TEMP" : "TMPDIR";
        const previousTemp = process.env[tempKey];
        let isolated;
        try {
            process.env[tempKey] = alias;
            isolated = await runFile(environmentTest, { reportDir: root });
        } finally {
            if (previousTemp === undefined) delete process.env[tempKey];
            else process.env[tempKey] = previousTemp;
        }
        assert.strictEqual(isolated.code, 0);
        const environmentLog = fs.readdirSync(root).find((file) => file.endsWith("environment.js.log"));
        const temporaryRoot = fs
            .readFileSync(path.join(root, environmentLog), "utf8")
            .match(/TEMP_ROOT=(.+)/)[1]
            .trim();
        assert.strictEqual(fs.existsSync(temporaryRoot), false, "runner must remove child fixtures");
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
