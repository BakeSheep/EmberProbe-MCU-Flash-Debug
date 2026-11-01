"use strict";
// The real MainViewProvider constructor with a fake VS Code API: the provider holds every service the composition root
// builds, the services' callbacks reach the provider, and shutdown releases what construction started.
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { createProvider } = require("./helpers/load-provider");
const { createServices } = require("../src/composition");

(async () => {
    await scenario("Hold every service the composition root builds", async () => {
        const { provider, vscode, context, dispose } = createProvider();
        try {
            const built = createServices(provider, context, { vscode });
            for (const [name, service] of Object.entries(built)) {
                const held = provider[`_${name}`];
                if (service === null) assert.strictEqual(held, null, name);
                else assert.strictEqual(held?.constructor, service.constructor, name);
            }
            assert.notStrictEqual(provider._bridgeRegistry, null, "the context has global storage");
            assert.strictEqual(provider._latestSidebarSamples, provider._liveWatchService.latestSidebarSamples);
            assert.strictEqual(typeof provider.commandHandlers["mcu-vscode.download"], "function");
        } finally {
            await dispose();
        }
    });

    await scenario("Route service callbacks and Agent calls to the provider", async () => {
        const { provider, dispose } = createProvider();
        try {
            const posts = [];
            provider._webviewView = { webview: { postMessage: (message) => posts.push(message) } };
            provider._probeCoordinator.acquire("chipInfo").release();
            assert(posts.some((message) => message.type === "probeOperationStatus"));
            assert(provider._agentService.methods().includes("variables.read"));
            const snapshot = await provider._agentService.call("config.get");
            assert.strictEqual(typeof snapshot, "object");
        } finally {
            await dispose();
        }
    });

    console.log("Provider construction tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
