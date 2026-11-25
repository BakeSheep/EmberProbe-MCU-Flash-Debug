"use strict";

const { TOOLS } = require("../src/mcp/tools");
const { CLIENTS, SERVER_NAME, configSnippet } = require("../src/services/mcpClientConfig");

function browserSource() {
    const spec = { command: "node", args: ["C:/EmberProbe/dist/mcpServer.js"], env: {} };
    return (
        "window.EmberProbeMockMcp = " +
        JSON.stringify({
            serverName: SERVER_NAME,
            clients: CLIENTS,
            tools: TOOLS.map(({ name }) => ({ name })),
            snippet: configSnippet("json", spec)
        }) +
        ";"
    );
}
module.exports = { browserSource };
