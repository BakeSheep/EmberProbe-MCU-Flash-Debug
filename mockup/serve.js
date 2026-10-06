/*
 * Tiny static server for the mock (no dependencies).
 * Usage: node mockup/serve.js [port]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "dist");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ttf": "font/ttf",
    ".woff": "font/woff"
};

function createMockServer(directory = dist) {
    const root = path.resolve(directory);
    return http.createServer((request, response) => {
        let urlPath;
        try {
            urlPath = decodeURIComponent((request.url || "/").split("?")[0]);
            if (urlPath.includes("\0")) throw new URIError("Invalid path");
        } catch {
            response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            response.end("Bad request");
            return;
        }
        const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const file = path.resolve(root, relative);
        const resolved = path.relative(root, file);
        let isFile = false;
        try {
            isFile =
                resolved !== ".." &&
                !resolved.startsWith(".." + path.sep) &&
                !path.isAbsolute(resolved) &&
                fs.statSync(file).isFile();
        } catch {
            // A missing or invalid path is a normal 404.
        }
        if (!isFile) {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("Not found");
            return;
        }
        response.writeHead(200, {
            "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream"
        });
        const stream = fs.createReadStream(file);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
    });
}

if (require.main === module) {
    if (!fs.existsSync(dist)) {
        console.error("mockup/dist not found. Run `node mockup/build.js` first.");
        process.exit(1);
    }
    const port = process.argv[2] === undefined ? 8085 : Number(process.argv[2]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port");
    const server = createMockServer();
    server.listen(port, "127.0.0.1", () => {
        console.log(`EmberProbe mock: http://localhost:${server.address().port}/`);
    });
}

module.exports = { createMockServer };
