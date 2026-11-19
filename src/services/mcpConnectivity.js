"use strict";
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { SERVER_NAME } = require("./mcpClientConfig");

const TIMEOUT_MS = 10000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

// Probe the launch spec owned by the extension. Client config files can contain arbitrary executables and environment
// variables, and listing tools is enough to test the MCP protocol without reaching the Bridge or the hardware.
/** @param {{ command: string, args: string[], env: Record<string, string> }} spec */
async function checkMcpConnection(spec, { clock = SYSTEM_CLOCK } = {}) {
    const client = new Client({ name: "emberprobe-connectivity", version: "1.0.0" });
    const transport = new StdioClientTransport({ ...spec, stderr: "ignore", maxBufferSize: MAX_MESSAGE_BYTES });
    // The SDK also closes on a failed handshake. Wait for that same cleanup before allowing another check.
    const close = transport.close.bind(transport);
    let closing;
    transport.close = () => (closing ||= close());
    const abort = new AbortController();
    const timer = clock.schedule(() => abort.abort(), TIMEOUT_MS);
    let stage = "initialize";
    try {
        const options = { signal: abort.signal };
        await client.connect(transport, options);
        if (client.getServerVersion()?.name !== SERVER_NAME) return { state: "initialize" };
        stage = "tools";
        const { tools } = await client.listTools({}, options);
        return tools.length ? { state: "connected", toolCount: tools.length } : { state: "tools" };
    } catch {
        return { state: abort.signal.aborted ? "timeout" : stage };
    } finally {
        clock.cancel(timer);
        await client.close();
    }
}

module.exports = { checkMcpConnection };
