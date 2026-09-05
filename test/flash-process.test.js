"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { runOpenOcd, probeOpenOcdCompatibility } = require("../skills/_emberprobe/flash-common");
function adapter(output, code = 0, error = null) {
    return (_file, _args, options) => {
        assert.strictEqual(options.shell, false);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        queueMicrotask(() => {
            if (error) child.emit("error", error);
            child.stdout.end(output);
            child.stderr.end();
            setImmediate(() => child.emit("close", code));
        });
        return child;
    };
}
(async () => {
    for (const [version, compatible] of [
        ["0.12.0", true],
        ["0.11.0", false]
    ]) {
        const status = await probeOpenOcdCompatibility(
            "fake-openocd",
            1000,
            adapter("Open On-Chip Debugger " + version)
        );
        assert.strictEqual(status.compatible, compatible);
    }
    const failed = await probeOpenOcdCompatibility("fake", 1000, () => {
        throw Error("spawn failed");
    });
    assert.strictEqual(failed.found, false);
    const result = await runOpenOcd("fake", ["--command"], { spawnProcess: adapter("EP_VERIFY OK\r\nlast line", 3) });
    assert.deepStrictEqual(result, { code: 3, lines: ["EP_VERIFY OK", "last line"] });
    await assert.rejects(runOpenOcd("fake", [], { spawnProcess: adapter("", 1, Error("denied")) }), /denied/);
    // Keep a real executable smoke test on all platforms; shell scripts are supplementary Unix coverage.
    const real = await runOpenOcd(process.execPath, ["-e", 'console.log("node-child-ready")']);
    assert.strictEqual(real.code, 0);
    assert.deepStrictEqual(real.lines, ["node-child-ready"]);
    console.log("Cross-platform flash process adapter tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
