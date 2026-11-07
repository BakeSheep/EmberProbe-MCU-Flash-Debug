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
const { chapters } = require("../website/tour-data");
const { scenes } = require("../website/capture/scenes");
const { cjkText, covered } = require("../website/capture/fonts");
const timeline = require("../website/assets/media/timeline.json");

// Claims the product no longer makes.
const RETIRED = [/跳过擦写|一致时跳过|skips? (the )?(erase|write)|仅暂停时|only while paused\. Peripheral/i];

function testPages() {
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        const doc = dom.window.document;
        assert.equal(doc.documentElement.lang, content[lang].htmlLang);
        assert.equal(doc.querySelectorAll("h1").length, 1);
        assert.equal(doc.querySelectorAll("[data-seek]").length, stepCount(content[lang]));
        assert.ok(doc.querySelector(".footer").textContent.includes("1.2.3-test"));
        assert.equal(doc.querySelectorAll("iframe").length, 0, "homepage does not load the editor");
        const videos = [...doc.querySelectorAll("video")];
        assert.equal(videos.length, content[lang].chapters.length + content[lang].tools.items.length + 1);
        for (const video of videos) {
            assert.equal(video.getAttribute("preload"), "none");
            assert.ok(video.hasAttribute("poster") || video.hasAttribute("data-poster"));
            assert.ok(video.hasAttribute("aria-label"));
        }
        for (const pattern of RETIRED) assert.doesNotMatch(doc.body.textContent, pattern);
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

const stepCount = (c) => c.chapters.reduce((total, chapter) => total + chapter.steps.length, 0);

function testChaptersMatchRecordings() {
    for (const c of Object.values(content)) {
        for (const chapter of c.chapters) {
            assert.equal(chapter.steps.length, timeline[chapter.id].steps.length, chapter.id);
            assert.equal(chapter.steps.length, scenes[chapter.id].steps.length, chapter.id);
        }
        for (const tool of c.tools.items) assert.ok(timeline[tool.id], tool.id);
    }
    assert.deepStrictEqual(Object.keys(timeline).sort(), Object.keys(scenes).sort());
}

function testTourTargetsExist() {
    const sources = [
        "src/modernView.js",
        "src/liveWatchView.js",
        "src/webview/sidebar/renderer.js",
        "src/webview/sidebar/agentControls.js",
        "src/webview/sidebar/chipView.js",
        "src/webview/sidebar/memoryView.js",
        "src/webview/sidebar/peripherals.js",
        "src/webview/liveWatch/renderer.js",
        "mockup/shell/index.html",
        "mockup/shell/shell.js"
    ].filter((file) => fs.existsSync(path.join(__dirname, "..", file)));
    const markup = sources.map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
    for (const chapter of chapters) {
        assert.ok(chapter.title.zh && chapter.title.en, chapter.id);
        assert.ok(chapter.steps.length, chapter.id);
        for (const step of chapter.steps) {
            for (const lang of ["zh", "en"]) assert.equal(step[lang].length, 2, chapter.id);
            if (typeof step.target !== "string") continue;
            for (const [, id] of step.target.matchAll(/#([A-Za-z][\w-]*)/g)) assert.ok(markup.includes(id), `#${id}`);
            for (const [, name] of step.target.matchAll(/data-command="([^"]+)"/g))
                assert.ok(markup.includes(name), name);
        }
    }
}

function testFontsCoverPages() {
    const subset = new Set(fs.readFileSync(covered, "utf8"));
    const missing = [...cjkText()].filter((character) => !subset.has(character));
    assert.deepStrictEqual(missing, [], "run website/capture/fonts.js to rebuild the font subset");
}

function testDemoReset() {
    for (const lang of ["en", "zh", "invalid"]) {
        const markup = demoPage().replace(/<script src="[^\"]+" defer><\/script>/g, "");
        const view = render(markup, {}, { url: origin + "demo/?lang=" + lang });
        try {
            view.window.localStorage.setItem("emberprobe.mock.theme", "dark");
            for (const file of ["tour-data.js", "demo.js"])
                view.window.eval(fs.readFileSync(path.join(__dirname, "../website", file), "utf8"));
            const initial = view.document.getElementById("demo-editor");
            const selected = lang === "en" ? "en" : "zh";
            assert.equal(view.document.querySelectorAll(".tour-chapter").length, chapters.length);
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
    scenario("every chapter has its recording and matching steps", testChaptersMatchRecordings);
    scenario("guided tour targets exist in the real pages", testTourTargetsExist);
    scenario("the font subset covers both pages and the tour", testFontsCoverPages);
    scenario("demo validates language and resets without changing stored preferences", testDemoReset);
    await scenario("preview serves project paths and rejects invalid paths", testServer);
    console.log("Website regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
