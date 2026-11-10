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
const { content, agentClients, mcpTools } = require("../website/content");
const { TOOLS } = require("../src/mcp/tools");
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
        assert.equal(doc.querySelectorAll(".points li").length, pointCount(content[lang]));
        assert.equal(doc.querySelectorAll(".pills li:not([aria-hidden])").length, supportCount(content[lang]));
        assert.ok(doc.querySelector(".hero-card img").getAttribute("alt"), "the first image is described");
        assert.ok(doc.querySelector(".footer").textContent.includes("1.2.3-test"));
        assert.equal(doc.querySelectorAll("iframe").length, 0, "homepage does not load the editor");
        const videos = [...doc.querySelectorAll("video")];
        assert.equal(videos.length, clipIds(content[lang]).length + content[lang].tools.items.length);
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

// The sampling zone has a recording per target state, one for types and one for plotting, plus stills.
const zoneClips = (zone) => [...zone.states.items.map((state) => state.id), "variables", "waveform"];
const clipIds = (c) => c.chapters.flatMap((chapter) => (chapter.zone ? zoneClips(chapter.zone) : chapter.id));
const zoneStills = (zone) => [
    ...zone.modes.cards.map((card) => ({ id: card.shot })),
    ...zone.types.gallery,
    ...zone.chart.shots
];
const pointCount = (c) =>
    c.chapters.reduce(
        (total, chapter) => total + (chapter.zone ? chapter.zone.types.points.length : (chapter.points?.length ?? 0)),
        0
    );
const supportCount = (c) =>
    c.chapters.reduce(
        (total, chapter) =>
            total +
            (chapter.support
                ? chapter.support.probes.items.length +
                  chapter.support.chips.items.length +
                  chapter.support.systems.items.length
                : 0),
        0
    );

function testChapterPresentation() {
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        try {
            const doc = dom.window.document;
            assert.ok(doc.querySelector("#config .support > h3").textContent.includes("OpenOCD"));
            assert.equal(doc.querySelectorAll("#config .support-group > h4").length, 3);
            const systems = doc.querySelector("#config .support-group:last-of-type .pills");
            assert.deepStrictEqual(
                [...systems.children].map((item) => item.textContent),
                ["Windows", "Linux", "macOS"]
            );
            const flash = doc.querySelector("#flash");
            assert.equal(flash.querySelector(".chapter-side"), null);
            assert.equal(flash.querySelector(".points"), null);
            assert.ok(flash.querySelector(".chapter-body.solo video"));
            assert.equal(flash.querySelectorAll(".controls button").length, 2);
        } finally {
            dom.window.close();
        }
    }
}

function testHeroAndSupportPresentation() {
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        try {
            const doc = dom.window.document;
            assert.equal(doc.querySelectorAll(".hero-card picture").length, 1);
            assert.equal(doc.querySelectorAll(".hero-layer, .hero-layers").length, 0);
            assert.equal(doc.querySelector(".hero-visual figcaption"), null);
            for (const list of [...doc.querySelectorAll("#config .pills")].slice(0, 2)) {
                assert.equal(list.lastElementChild.textContent, "…");
                assert.equal(list.lastElementChild.getAttribute("aria-hidden"), "true");
            }
        } finally {
            dom.window.close();
        }
    }
}

function testChaptersMatchRecordings() {
    for (const c of Object.values(content)) {
        for (const id of clipIds(c)) assert.ok(timeline[id]?.steps, id);
        for (const chapter of c.chapters.filter((item) => item.zone)) {
            for (const still of zoneStills(chapter.zone)) assert.ok(timeline[still.id]?.still, still.id);
        }
        for (const tool of c.tools.items) assert.ok(timeline[tool.id], tool.id);
    }
    assert.deepStrictEqual(Object.keys(timeline).sort(), Object.keys(scenes).sort());
    for (const [name, scene] of Object.entries(scenes)) {
        if (scene.cropTo) {
            // Cropped to an element, so each language keeps the size its own layout gave.
            assert.ok(timeline[name].still, name);
            for (const lang of ["zh", "en"]) {
                const size = timeline[name][lang];
                assert.ok(size.width > 0 && size.width <= scene.window.width, `${name} ${lang}`);
                assert.ok(size.height > 0 && size.height <= scene.window.height, `${name} ${lang}`);
            }
        } else if (scene.still) {
            assert.ok(timeline[name].still, name);
            assert.equal(timeline[name].width, scene.window.width, name);
            assert.equal(timeline[name].height, scene.window.height, name);
        } else {
            assert.equal(timeline[name].steps.length, scene.steps.length, name);
        }
    }
}

function testSamplingZone() {
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        try {
            const doc = dom.window.document;
            const zone = content[lang].chapters.find((chapter) => chapter.zone).zone;
            const section = doc.getElementById("sampling");
            assert.ok(section.matches(".chapter.zone-sampling"));
            assert.equal(doc.querySelectorAll('.header nav a[href="#sampling"]').length, 1);
            for (const id of ["variables", "waveform"])
                assert.equal(doc.querySelectorAll(`.header nav a[href="#${id}"]`).length, 0);
            const parts = [zone.modes, zone.states, zone.types, zone.chart];
            assert.deepStrictEqual(
                parts.map((part) => part.id),
                ["sampling-modes", "sampling-states", "variables", "waveform"]
            );
            assert.equal(section.querySelector(".zone-nav"), null);
            for (const part of parts) assert.ok(section.querySelector(`#${part.id}.zone-part`), part.id);
            assert.equal(section.querySelectorAll(".zone-stats li").length, zone.stats.length);
            // The sweep's bright trace shows through a mask the page defines once.
            const hot = section.querySelector(".scope .scope-hot");
            const maskId = hot.getAttribute("mask").match(/^url\(#(.+)\)$/)[1];
            assert.equal(doc.querySelectorAll(`[id="${maskId}"]`).length, 1);
            assert.ok(doc.getElementById(maskId).querySelector(".scope-band"));
            assert.ok(section.querySelector(".scope .scope-cursor"));
            assert.equal(section.querySelectorAll(".feature-grid li").length, zone.chart.features.length);

            // Each way to watch shows its real UI.
            const cards = [...section.querySelectorAll(".mode-card")];
            assert.equal(cards.length, zone.modes.cards.length);
            cards.forEach((card, i) =>
                assert.ok(card.querySelector(`.mode-shot img[src$="${zone.modes.cards[i].shot}-${lang}.webp"]`))
            );
            assert.equal(section.querySelectorAll(".mode-silent").length, 1);
            assert.equal(section.querySelector(".mode-card .mode-silent"), null);
            for (const card of cards) assert.equal(card.querySelectorAll(".mode-facts > div").length, 3);
            assert.equal(section.querySelectorAll(".silent-flow li").length, 3);

            // Each target state is its own row with its own recording.
            const states = [...section.querySelectorAll(".states > .state")];
            assert.equal(states.length, 3);
            states.forEach((row, i) => {
                const state = zone.states.items[i];
                assert.ok(row.classList.contains(`state-${i + 1}`));
                assert.equal(row.querySelector("h4").textContent, state.name);
                assert.equal(row.querySelector(".state-tag").textContent, state.tag);
                assert.ok(row.querySelector(`.state-clip video[data-poster$="${state.id}-${lang}.webp"]`), state.id);
            });

            // Types are tiled stills: no tabs, no source code.
            const grid = section.querySelector(".type-grid");
            assert.equal(grid.querySelectorAll(".type-card").length, zone.types.gallery.length);
            for (const item of zone.types.gallery) {
                const image = grid.querySelector(`img[src$="${item.id}-${lang}.webp"]`);
                assert.ok(image, item.id);
                assert.ok(image.getAttribute("width") && image.getAttribute("height") && image.getAttribute("alt"));
            }
            assert.equal(section.querySelectorAll('[role="tab"], pre, code').length, 0);
            for (const shot of zone.chart.shots)
                assert.ok(section.querySelector(`img[src$="${shot.id}-${lang}.webp"]`));
            assert.equal(section.querySelector(".chart-shot figcaption"), null);
        } finally {
            dom.window.close();
        }
    }
}

function testAgentCapabilities() {
    const toolNames = TOOLS.map((tool) => tool.name).sort();
    assert.deepStrictEqual(Object.values(mcpTools).flat().sort(), toolNames, "cover every tool exactly once");
    for (const lang of ["zh", "en"]) {
        const dom = new JSDOM(home(lang, "1.2.3-test"));
        try {
            const doc = dom.window.document;
            const agent = doc.getElementById("agent");
            assert.equal(agent.querySelector(".talk"), null);
            const clients = [...agent.querySelectorAll(".client-logos li")];
            assert.deepStrictEqual(
                clients.map((client) => client.textContent),
                agentClients.map(([, name]) => name)
            );
            for (const client of clients) {
                const image = client.querySelector("img");
                const asset = path.join(__dirname, "../website", lang === "en" ? "en" : "", image.getAttribute("src"));
                assert.ok(fs.existsSync(asset), asset);
                assert.equal(image.getAttribute("alt"), "", "the adjacent client name labels the logo");
            }
            assert.deepStrictEqual(
                [...agent.querySelectorAll(".capability-tools code")].map((code) => code.textContent).sort(),
                toolNames,
                "both languages render the complete MCP catalogue"
            );
            assert.equal(agent.querySelectorAll(".capability-card").length, 6);
            assert.equal(agent.querySelectorAll(".capability-tool-group").length, Object.keys(mcpTools).length);
            for (const details of agent.querySelectorAll("details.capability-tools")) {
                assert.ok(details.querySelector("summary").textContent);
                assert.equal(details.open, false, "tool details start collapsed");
            }
        } finally {
            dom.window.close();
        }
    }
}

function testHeroMotion() {
    for (const mode of ["desktop", "narrow", "touch", "reduced"]) {
        const markup = `<html class="${mode === "reduced" ? "" : "motion"}"><body><section data-hero><div data-hero-scene><div data-hero-card></div></div></section></body></html>`;
        const view = render(
            markup,
            {},
            {
                beforeParse(window) {
                    window.matchMedia = (query) => ({
                        matches: query.includes("min-width") ? mode !== "narrow" : mode !== "touch"
                    });
                }
            }
        );
        try {
            const scene = view.document.querySelector("[data-hero-scene]");
            const card = view.document.querySelector("[data-hero-card]");
            scene.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 440 });
            view.window.eval(fs.readFileSync(path.join(__dirname, "../website/motion.js"), "utf8"));
            scene.dispatchEvent(new view.window.MouseEvent("pointermove", { clientX: 640, clientY: 0 }));
            assert.equal(Boolean(card.style.getPropertyValue("--hero-ry")), mode === "desktop");
            assert.equal(card.style.willChange, "", "do not pin the screenshot to a fixed raster scale");
            scene.dispatchEvent(new view.window.MouseEvent("pointerleave"));
            assert.equal(card.style.getPropertyValue("--hero-rx"), "");
            assert.equal(card.style.getPropertyValue("--hero-ry"), "");
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
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
    scenario("compatibility has a heading and flashing keeps a standalone playable demo", testChapterPresentation);
    scenario(
        "hero uses one complete screenshot and both compatibility lists end with an ellipsis",
        testHeroAndSupportPresentation
    );
    scenario("every chapter has its recording and matching steps", testChaptersMatchRecordings);
    scenario("sampling is one themed zone with modes, states, tiled types and stills", testSamplingZone);
    scenario(
        "Agent clients have local logos and both languages show the complete MCP catalogue",
        testAgentCapabilities
    );
    scenario("hero tilt responds on desktop and respects narrow, touch and reduced motion", testHeroMotion);
    scenario("guided tour targets exist in the real pages", testTourTargetsExist);
    scenario("the font subset covers both pages and the tour", testFontsCoverPages);
    scenario("demo validates language and resets without changing stored preferences", testDemoReset);
    await scenario("preview serves project paths and rejects invalid paths", testServer);
    console.log("Website regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
