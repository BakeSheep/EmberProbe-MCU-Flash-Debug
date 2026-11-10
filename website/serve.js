"use strict";

const http = require("http");
const { createMockServer } = require("../mockup/serve");
const { output } = require("./build");
const base = "/EmberProbe-MCU-Flash-Debug/";

function createSiteServer(directory = output) {
    const files = createMockServer(directory);
    return http.createServer((request, response) => {
        const incoming = request.url || "/";
        if (incoming === "/" || incoming === base.slice(0, -1)) {
            response.writeHead(302, { location: base });
            response.end();
            return;
        }
        if (!incoming.startsWith(base)) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        const [pathname, query] = incoming.slice(base.length).split("?");
        request.url =
            "/" +
            (pathname.endsWith("/") || !pathname ? pathname + "index.html" : pathname) +
            (query ? "?" + query : "");
        files.emit("request", request, response);
    });
}

if (require.main === module) {
    const port = Number(process.argv[2] || 8086);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid site port");
    const server = createSiteServer();
    server.listen(port, "127.0.0.1", () =>
        console.log(`EmberProbe website: http://127.0.0.1:${server.address().port}${base}`)
    );
}
module.exports = { createSiteServer, base };
