"use strict";
const assert = require("assert");
const path = require("path");
const { checkMcpConnection } = require("../src/services/mcpConnectivity");
const { TOOLS } = require("../src/mcp/tools");
const { FakeClock } = require("./helpers/fake-clock");
const { scenario } = require("./helpers/scenario");

const env = { ELECTRON_RUN_AS_NODE: "1" };
const entry = path.resolve(__dirname, "../src/mcp/server.js");

(async () => {
    await scenario("Open a real EmberProbe stdio connection and enumerate its tools", async () => {
        const result = await checkMcpConnection({ command: process.execPath, args: [entry], env });
        assert.deepStrictEqual(result, { state: "connected", toolCount: TOOLS.length });
    });

    await scenario("Report startup and tool enumeration failures at their respective stages", async () => {
        const spec = { command: process.execPath, args: [entry + ".missing"], env };
        assert.deepStrictEqual(await checkMcpConnection(spec), { state: "initialize" });

        const server = require.resolve("@modelcontextprotocol/sdk/server/index.js");
        const stdio = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
        const script = `
            const { Server } = require(${JSON.stringify(server)});
            const { StdioServerTransport } = require(${JSON.stringify(stdio)});
            new Server({ name: "emberprobe", version: "1.0.0" }).connect(new StdioServerTransport());
        `;
        assert.deepStrictEqual(await checkMcpConnection({ ...spec, args: ["-e", script] }), { state: "tools" });
    });

    await scenario("Time out an unresponsive stdio server and clear the deadline", async () => {
        const clock = new FakeClock();
        const result = checkMcpConnection(
            { command: process.execPath, args: ["-e", "process.stdin.resume()"], env },
            { clock }
        );
        await clock.advance(10000);
        assert.deepStrictEqual(await result, { state: "timeout" });
        assert.strictEqual(clock.tasks.size, 0);
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
