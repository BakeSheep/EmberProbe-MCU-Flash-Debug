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
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".webp": "image/webp",
    ".mp4": "video/mp4"
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
        const headers = {
            "accept-ranges": "bytes",
            "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream"
        };
        // Browsers can only seek a video when the server answers range requests, as GitHub Pages does.
        const size = fs.statSync(file).size;
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (range && start < size && start <= end) {
            headers["content-range"] = `bytes ${start}-${end}/${size}`;
            headers["content-length"] = end - start + 1;
            response.writeHead(206, headers);
        } else {
            response.writeHead(200, headers);
        }
        const stream = fs.createReadStream(file, range && start < size && start <= end ? { start, end } : {});
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
