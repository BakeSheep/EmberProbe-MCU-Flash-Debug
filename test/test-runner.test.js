"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { discover, parseJobs, runFile, runFiles } = require("../scripts/run-tests");
const {
    TEST_GROUPS,
    discoverTopLevelTests,
    groupFor,
    testsForGroup,
    validateGroups
} = require("../scripts/test-groups");
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
            isolated = await runFile(environmentTest, { reportDir: root, keepLogs: true });
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
        assert.strictEqual(
            fs.readdirSync(root).some((file) => file.endsWith("pass.js.log")),
            false,
            "passing logs should be opt-in"
        );
        await runFile(path.join(root, "pass.js"), { reportDir: root, keepLogs: true });
        assert.ok(
            fs.readdirSync(root).some((file) => file.endsWith("pass.js.log")),
            "--keep-logs should retain passes"
        );
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

        const parallelLog = path.join(root, "parallel.log");
        const poolMode = path.join(root, "pool-mode");
        fs.writeFileSync(poolMode, "parallel");
        const parallelFiles = ["one.js", "two.js", "three.js"].map((name) => {
            const file = path.join(root, name);
            fs.writeFileSync(
                file,
                [
                    'const fs = require("fs");',
                    "const marker = " + JSON.stringify(parallelLog) + ";",
                    "const mode = " + JSON.stringify(poolMode) + ";",
                    'fs.appendFileSync(marker, "start\\n");',
                    "const deadline = Date.now() + 5000;",
                    "function finish() {",
                    '    const starts = (fs.readFileSync(marker, "utf8").match(/start/g) || []).length;',
                    '    if (fs.readFileSync(mode, "utf8") === "parallel" && starts < 2) {',
                    "        if (Date.now() > deadline) throw new Error('second worker did not start');",
                    "        return setTimeout(finish, 20);",
                    "    }",
                    '    setTimeout(() => fs.appendFileSync(marker, "end\\n"), 50);',
                    "}",
                    "finish();"
                ].join("\n")
            );
            return file;
        });
        const parallelResults = await runFiles(parallelFiles, { jobs: 2, reportDir: root });
        assert.deepStrictEqual(
            parallelResults.map((result) => result.file),
            parallelFiles.map((file) => path.relative(path.resolve(__dirname, ".."), file).replace(/\\/g, "/")),
            "parallel results retain discovery order"
        );
        assert.ok(
            fs.readFileSync(parallelLog, "utf8").startsWith("start\nstart\n"),
            "worker pool must run concurrently"
        );
        const events = fs
            .readFileSync(parallelLog, "utf8")
            .trim()
            .split("\n")
            .reduce(
                (state, event) => {
                    state.active += event === "start" ? 1 : -1;
                    state.maximum = Math.max(state.maximum, state.active);
                    return state;
                },
                { active: 0, maximum: 0 }
            );
        assert.strictEqual(events.maximum, 2, "worker pool must honor --jobs");
        assert.strictEqual(events.active, 0, "all workers must complete");
        fs.writeFileSync(parallelLog, "");
        fs.writeFileSync(poolMode, "serial");
        const serialResults = await runFiles(parallelFiles, { jobs: 1 });
        assert.deepStrictEqual(fs.readFileSync(parallelLog, "utf8"), "start\nend\nstart\nend\nstart\nend\n");
        assert.deepStrictEqual(
            serialResults.map((result) => result.file),
            parallelResults.map((result) => result.file)
        );

        const completionMarker = path.join(root, "completion.marker");
        const failingPoolFile = path.join(root, "failing-pool.js");
        const completingPoolFile = path.join(root, "completing-pool.js");
        fs.writeFileSync(failingPoolFile, "process.exitCode=7;");
        fs.writeFileSync(
            completingPoolFile,
            `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(completionMarker)}, "completed"), 120);`
        );
        const poolResults = await runFiles([failingPoolFile, completingPoolFile], { jobs: 2, reportDir: root });
        assert.strictEqual(poolResults[0].code, 7);
        assert.strictEqual(fs.readFileSync(completionMarker, "utf8"), "completed", "workers must drain after failure");

        const topLevelTests = discoverTopLevelTests(path.resolve(__dirname, ".."));
        assert.strictEqual(parseJobs(["--jobs", "2"]), 2);
        assert.throws(() => parseJobs(["--jobs", "0"]), /positive integer/);
        assert.throws(() => parseJobs(["--jobs"]), /requires a value/);
        assert.strictEqual(validateGroups(topLevelTests), true);
        assert.throws(
            () => validateGroups([...topLevelTests, topLevelTests[0]]),
            /Duplicate test file/,
            "manifest must reject duplicate entries"
        );
        assert.throws(
            () => validateGroups(topLevelTests, { fast: ["missing.test.js"], integration: [], release: [] }),
            /references missing file/,
            "manifest must reject unknown files"
        );
        assert.throws(() => validateGroups(topLevelTests, { ...TEST_GROUPS, fast: [] }), /Test has no group/);
        assert.throws(
            () =>
                validateGroups(topLevelTests, {
                    ...TEST_GROUPS,
                    fast: [...TEST_GROUPS.fast, TEST_GROUPS.integration[0]]
                }),
            /multiple groups/
        );
        assert.throws(() => groupFor("missing.test.js"), /Test has no group/);
        assert.throws(() => testsForGroup(path.resolve(__dirname, ".."), "../../.."), /Unknown test group/);
        const core = testsForGroup(path.resolve(__dirname, ".."), "core");
        const fast = testsForGroup(path.resolve(__dirname, ".."), "fast");
        const integration = testsForGroup(path.resolve(__dirname, ".."), "integration");
        assert.strictEqual(core.length, fast.length + integration.length);
        assert.deepStrictEqual(
            fast.map((file) => path.basename(file)),
            TEST_GROUPS.fast
        );
        assert.deepStrictEqual(
            integration.map((file) => path.basename(file)),
            [...TEST_GROUPS.integration].sort()
        );
        assert.ok(fast.length > 0 && integration.length > 0);
        assert.strictEqual(testsForGroup(path.resolve(__dirname, ".."), "release").length, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Test runner diagnostics and timeout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
