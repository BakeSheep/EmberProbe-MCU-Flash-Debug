"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { JSDOM } = require("jsdom");
const { scenario } = require("./helpers/scenario");
const { render } = require("./helpers/render-webview");
const { home, demoPage, origin } = require("../website/template");
const { createSiteServer, base } = require("../website/serve");
const { content } = require("../website/content");

function testPages() {
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        const doc = dom.window.document;
        assert.equal(doc.documentElement.lang, content[lang].htmlLang);
        assert.equal(doc.querySelectorAll("h1").length, 1);
        assert.equal(doc.querySelectorAll("[data-flow]").length, 4);
        assert.equal(doc.querySelectorAll("[data-scene]").length, 4);
        assert.ok(doc.querySelector(".release").textContent.includes("1.2.3-test"));
        assert.equal(doc.querySelectorAll("iframe, video").length, 0, "homepage does not preload heavy demo media");
        const pageUrl = new URL(lang === "en" ? "en/" : "", origin);
        for (const image of doc.querySelectorAll("img[src]")) {
            assert.ok(new URL(image.src, pageUrl).pathname.startsWith(new URL(origin).pathname));
            assert.ok(image.hasAttribute("alt"));
        }
        assert.equal(doc.querySelector('link[rel="canonical"]').href, pageUrl.href);
        assert.equal(doc.querySelectorAll('link[rel="alternate"]').length, 3);
        dom.window.close();
    }
}

function testDemoReset() {
    for (const lang of ["en", "zh", "invalid"]) {
        const markup = demoPage().replace(/<script src="[^\"]+" defer><\/script>/, "");
        const view = render(markup, {}, { url: origin + "demo/?lang=" + lang });
        try {
            view.window.localStorage.setItem("emberprobe.mock.theme", "dark");
            view.window.eval(fs.readFileSync(path.join(__dirname, "../website/demo.js"), "utf8"));
            const initial = view.document.getElementById("demo-editor");
            const selected = lang === "en" ? "en" : "zh";
            assert.equal(initial.getAttribute("src"), `editor/?lang=${selected}&theme=light`);
            assert.equal(view.document.documentElement.lang, content[selected].htmlLang);
            initial.dataset.testSession = "old-session";
            const resets = view.document.getElementById("reset-demo");
            resets.click();
            const next = view.document.getElementById("demo-editor");
            assert.notEqual(initial, next, "reset creates a fresh browsing context");
            assert.equal(initial.isConnected, false);
            assert.equal(next.src, initial.src);
            resets.click();
            assert.notEqual(next, view.document.getElementById("demo-editor"), "reset works repeatedly");
            assert.equal(view.window.localStorage.getItem("emberprobe.mock.theme"), "dark");
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
}

async function testServer() {
    // Serve the tracked sources: directory routing and project-path rules do not need a generated build.
    const server = createSiteServer(path.join(__dirname, "../mockup/shell"));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    function request(url) {
        return new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: server.address().port, path: url }, (response) => {
                response.resume();
                response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location }));
            }).on("error", reject);
        });
    }
    try {
        assert.deepStrictEqual(await request("/"), { status: 302, location: base });
        assert.equal((await request(base + "?lang=en")).status, 200);
        assert.equal((await request(base + "shell.js")).status, 200);
        assert.equal((await request("/shell.js")).status, 404);
        assert.equal((await request(base + "../mock/theme.js")).status, 404);
        assert.equal((await request(base + "%")).status, 400);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

(async () => {
    scenario("both languages render complete static pages under the project base", testPages);
    scenario("demo validates language and resets without changing stored preferences", testDemoReset);
    await scenario("preview serves project paths and rejects invalid paths", testServer);
    console.log("Website regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
