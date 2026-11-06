"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { RttLogWriter } = require("../src/services/rttLogWriter");

function tempLog() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-log-"));
    return {
        dir,
        file: path.join(dir, "rtt.log"),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
}

(async () => {
    await scenario("appends to and continues an existing file", async () => {
        const { file, cleanup } = tempLog();
        try {
            fs.writeFileSync(file, "old");
            const writer = new RttLogWriter({ maxBytes: 1024 });
            writer.open(file);
            writer.append("new");
            writer.close();
            assert.strictEqual(fs.readFileSync(file, "utf8"), "oldnew");
        } finally {
            cleanup();
        }
    });

    await scenario("rotates the full file to the .1 backup and starts fresh", async () => {
        const { file, cleanup } = tempLog();
        try {
            const writer = new RttLogWriter({ maxBytes: 10 });
            writer.open(file);
            writer.append("0123456789");
            writer.append("x"); // Would exceed the limit, so the full file becomes the backup.
            writer.append("yz");
            writer.close();
            assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "0123456789");
            assert.strictEqual(fs.readFileSync(file, "utf8"), "xyz");
        } finally {
            cleanup();
        }
    });

    await scenario("a rotation replaces the previous backup", async () => {
        const { file, cleanup } = tempLog();
        try {
            const writer = new RttLogWriter({ maxBytes: 4 });
            writer.open(file);
            writer.append("aaaa");
            writer.append("bbbb");
            writer.append("cc");
            writer.close();
            assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "bbbb");
            assert.strictEqual(fs.readFileSync(file, "utf8"), "cc");
        } finally {
            cleanup();
        }
    });

    await scenario("a single oversized chunk stays within both file budgets", async () => {
        const { file, cleanup } = tempLog();
        try {
            const writer = new RttLogWriter({ maxBytes: 4 });
            writer.open(file);
            writer.append("0123456789abcdef");
            assert.strictEqual(fs.readFileSync(file, "utf8"), "cdef");
            assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "89ab");
            writer.append("x");
            writer.close();
            assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "cdef");
            assert.strictEqual(fs.readFileSync(file, "utf8"), "x");
        } finally {
            cleanup();
        }
    });

    await scenario("a broken path fails once and stops writing", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-log-"));
        try {
            const failures = [];
            const writer = new RttLogWriter({
                maxBytes: 64,
                onError: (error, file) => failures.push({ code: error.code, file })
            });
            writer.open(path.join(dir, "missing", "rtt.log"));
            writer.append("first");
            writer.append("second");
            assert.strictEqual(failures.length, 1, "the failure is reported once");
            assert.strictEqual(failures[0].code, "ENOENT");
            assert.ok(failures[0].file.endsWith("rtt.log"), "the report names the file");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("rotation keeps Unicode characters intact", async () => {
        const { file, cleanup } = tempLog();
        try {
            const writer = new RttLogWriter({ maxBytes: 4 });
            writer.open(file);
            writer.append("中文😀");
            assert.strictEqual(fs.readFileSync(file, "utf8"), "😀");
            assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "文");
            assert.ok(fs.statSync(file).size <= 4);
        } finally {
            cleanup();
        }
    });

    await scenario("a raw log keeps every byte and rotates at the exact limit", async () => {
        const { file, cleanup } = tempLog();
        try {
            const writer = new RttLogWriter({ maxBytes: 4, raw: true });
            writer.open(file);
            assert.strictEqual(writer.raw, true);
            writer.appendBytes(Buffer.from("温度"));
            writer.close();
            assert.deepStrictEqual(fs.readFileSync(`${file}.1`), Buffer.from("温度").subarray(0, 4));
            assert.deepStrictEqual(fs.readFileSync(file), Buffer.from("温度").subarray(4));
        } finally {
            cleanup();
        }
    });

    await scenario("an invalid size is rejected", async () => {
        assert.throws(() => new RttLogWriter({ maxBytes: 0 }), /Invalid RTT log size/);
    });
    console.log("RTT log writer tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
