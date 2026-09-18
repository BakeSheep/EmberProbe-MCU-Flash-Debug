"use strict";
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    const child = spawn(process.execPath, [path.join(extension.extensionPath, "dist/debugAdapter.js")], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = Buffer.alloc(0);
    const messages = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const split = buffer.indexOf("\r\n\r\n");
            if (split < 0) break;
            const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())[1]);
            if (buffer.length < split + 4 + length) break;
            messages.push(JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()));
            buffer = buffer.subarray(split + 4 + length);
        }
    });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error("Packaged debug adapter timed out: " + stderr));
            }, 10000);
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                if (code !== 0) reject(new Error(stderr));
                else resolve();
            });
            for (const [index, command] of ["initialize", "unsupported", "disconnect"].entries()) {
                const body = JSON.stringify({ seq: index + 1, type: "request", command, arguments: {} });
                child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            }
        });
        const responses = messages.filter((message) => message.type === "response");
        for (const seq of [1, 2, 3])
            assert.strictEqual(responses.filter((message) => message.request_seq === seq).length, 1);
        assert(responses.find((message) => message.command === "initialize").body.supportsFunctionBreakpoints);
        assert.strictEqual(responses.find((message) => message.command === "unsupported").success, false);
        assert.strictEqual(messages.filter((message) => message.event === "terminated").length, 1);
        console.log("✓ packaged debug adapter speaks framed DAP and responds once per request");
    } finally {
        child.kill();
    }
}
module.exports = { run };
