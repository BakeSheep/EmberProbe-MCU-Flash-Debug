"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { JSDOM } = require("jsdom");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { render } = require("./helpers/render-webview");
const { home, demoPage, installPage, origin } = require("../website/template");
const { createSiteServer, base } = require("../website/serve");
const { content, extensionId, chipVendors, agentClients, mcpTools } = require("../website/content");
const { TOOLS } = require("../src/mcp/tools");
const { chapters } = require("../website/tour-data");
const { scenes } = require("../website/capture/scenes");
const { cjkText, covered } = require("../website/capture/fonts");
const timeline = require("../website/assets/media/timeline.json");
const { publisher, name } = require("../package.json");

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
        const [install, marketplace] = doc.querySelectorAll(".hero-actions a:not([hidden])");
        const extensionId = `${publisher}.${name}`;
        assert.equal(install.getAttribute("href"), `vscode:extension/${extensionId}`);
        assert.equal(marketplace.href, `https://marketplace.visualstudio.com/items?itemName=${extensionId}`);
        assert.ok(doc.querySelector(".footer").textContent.includes("1.2.3-test"));
        assert.equal(doc.querySelectorAll("iframe").length, 0, "homepage does not load the editor");
        const videos = [...doc.querySelectorAll("video")];
        assert.equal(videos.length, clipIds(content[lang]).length + content[lang].tools.items.length);
        for (const video of videos) {
            assert.equal(video.getAttribute("preload"), "none");
            assert.ok(video.hasAttribute("data-src"));
            const poster = video.parentElement.querySelector(".clip-poster");
            assert.ok(poster.hasAttribute("data-poster"));
            assert.equal(poster.hasAttribute("src"), false);
            assert.equal(video.querySelector("source"), null);
            assert.equal(video.hasAttribute("src") || video.hasAttribute("poster"), false);
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

const zoneClips = (zone) => [...zone.states.items.map((state) => state.id), zone.chart.id];
const clipIds = (c) =>
    c.chapters.flatMap((chapter) => (chapter.zone ? zoneClips(chapter.zone) : chapter.clip || chapter.id));
const zoneStills = (zone) => [
    ...zone.modes.cards.map((card) => ({ id: card.shot })),
    ...zone.types.gallery,
    ...zone.chart.shots
];
const pointCount = (c) => c.chapters.reduce((total, chapter) => total + (chapter.points?.length ?? 0), 0);
const supportCount = (c) =>
    c.chapters.reduce(
        (total, chapter) =>
            total +
            (chapter.support
                ? chapter.support.probes.items.length +
                  chipVendors.reduce((count, [, , series]) => count + series.length, 0) +
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
            assert.equal(doc.querySelectorAll("#config .support-group > h4").length, 2);
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
            const vendors = [...doc.querySelectorAll("#supported-chips .chip-vendor")];
            assert.equal(doc.querySelector("#supported-chips p, #supported-chips a"), null);
            assert.deepStrictEqual(
                vendors.slice(0, 5).map((vendor) => vendor.querySelector("h4 strong").textContent),
                ["STM32", "GD32", "APM32", "AT32", "CH32"]
            );
            assert.deepStrictEqual(
                vendors.map((vendor) => [...vendor.querySelectorAll(".pills li")].map((item) => item.textContent)),
                chipVendors.map(([, , series]) => series)
            );
            const write = doc.getElementById("write");
            assert.ok(doc.querySelector('.header nav a[href="#write"]'));
            assert.ok(write.querySelector(`img[data-poster$="variables-${lang}.webp"]`));
            assert.ok(write.querySelector(`img[src$="write-member-${lang}.webp"]`));
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
            const more = doc.querySelector("#config .support .pills li:last-child");
            assert.equal(more.textContent, "…");
            assert.equal(more.getAttribute("aria-hidden"), "true");
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
        for (const chapter of c.chapters.filter((item) => item.shot)) assert.ok(timeline[chapter.shot.id]?.still);
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
                assert.ok(row.querySelector(`.state-clip img[data-poster$="${state.id}-${lang}.webp"]`), state.id);
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
            const pointer = grid.querySelector(`.type-card:has(img[src$="type-pointer-${lang}.webp"])`);
            assert.match(pointer.querySelector("h4").textContent, /C\+\+/);
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
            assert.ok(agent.querySelector('img[src$="workbuddy.svg"]'));
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

async function testPointerMotion() {
    for (const mode of ["desktop", "narrow", "touch", "reduced"]) {
        const clock = new FakeClock();
        let rafSeq = 0;
        const rafCallbacks = new Map();
        const markup = `<html class="${mode === "reduced" ? "" : "motion"}"><body><section data-hero><i class="hero-grid-light"></i><div data-hero-scene><div data-hero-card></div></div></section>
<div class="clip-frame"><div class="clip-flight"><div class="float-shadow"></div><figure class="stage"><div class="screen"></div><div class="controls"></div><span class="clip-rim"><i class="clip-rim-glow"></i></span></figure></div></div></body></html>`;
        const view = render(
            markup,
            {},
            {
                beforeParse(window) {
                    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
                    window.matchMedia = (query) => ({
                        matches: {
                            "(min-width: 901px)": mode !== "narrow",
                            "(hover: hover) and (pointer: fine)": mode !== "touch",
                            "(prefers-reduced-motion: reduce)": mode === "reduced"
                        }[query]
                    });
                    window.setTimeout = clock.schedule;
                    window.clearTimeout = clock.cancel;
                    window.performance.now = clock.now;
                    window.requestAnimationFrame = (update) => {
                        const id = ++rafSeq;
                        rafCallbacks.set(id, update);
                        return id;
                    };
                    window.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
                }
            }
        );
        async function flushFrames(maxSteps = 250) {
            let count = 0;
            while (rafCallbacks.size > 0) {
                assert.ok(count++ < maxSteps, "animation loop did not converge");
                const batch = [...rafCallbacks.entries()];
                rafCallbacks.clear();
                await clock.advance(16);
                const now = clock.now();
                for (const [, update] of batch) update(now);
            }
            return count;
        }
        try {
            const hero = view.document.querySelector("[data-hero]");
            const scene = view.document.querySelector("[data-hero-scene]");
            const card = view.document.querySelector("[data-hero-card]");
            const glow = hero.querySelector(".hero-grid-light");
            const heroBounds = () => ({ left: 0, top: 0, right: 640, bottom: 440, width: 640, height: 440 });
            const clipBounds = () => ({ left: 0, top: 200, right: 640, bottom: 640, width: 640, height: 440 });
            hero.getBoundingClientRect = scene.getBoundingClientRect = heroBounds;

            const surface = view.document.querySelector(".clip-frame");
            const stage = surface.querySelector(".stage");
            const shadow = surface.querySelector(".float-shadow");
            const screen = stage.querySelector(".screen");
            const controls = stage.querySelector(".controls");
            const rim = stage.querySelector(".clip-rim");
            const rimGlow = rim.querySelector(".clip-rim-glow");
            surface.getBoundingClientRect = clipBounds;

            view.window.eval(fs.readFileSync(path.join(__dirname, "../website/motion.js"), "utf8"));
            scene.dispatchEvent(new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 640, clientY: 0 }));
            await flushFrames();
            assert.equal(Boolean(card.style.getPropertyValue("--hero-ry")), mode === "desktop");
            assert.equal(glow.classList.contains("lit"), mode === "desktop");
            assert.equal(card.style.willChange, "", "do not pin the screenshot to a fixed raster scale");
            hero.dispatchEvent(new view.window.MouseEvent("pointerleave"));
            assert.equal(card.style.getPropertyValue("--hero-rx"), "");
            assert.equal(card.style.getPropertyValue("--hero-ry"), "");
            assert.equal(glow.classList.contains("lit"), false);

            view.document.documentElement.dispatchEvent(new view.window.MouseEvent("pointerleave"));
            await flushFrames();

            // Proximity outside the stage (90px right of edge, inside RIM_REACH = 180 and TILT_REACH = 420).
            view.window.dispatchEvent(
                new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 730, clientY: 420 })
            );
            if (mode !== "desktop") {
                assert.equal(rafCallbacks.size, 0);
                screen.dispatchEvent(
                    new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 640, clientY: 420 })
                );
                assert.equal(rafCallbacks.size, 0);
                assert.equal(stage.style.transform, "");
                assert.equal(shadow.style.transform, "");
                assert.equal(rim.classList.contains("lit"), false);
            } else {
                assert.equal(rafCallbacks.size, 1);
                await flushFrames();
                assert.ok(rim.classList.contains("lit"));
                const rimOpacity = parseFloat(rim.style.opacity);
                assert.ok(rimOpacity > 0 && rimOpacity < 1, `expected partial rim opacity, got ${rim.style.opacity}`);
                assert.match(rimGlow.style.transform, /^translate3d\(730px,\s*220px,\s*0(?:px)?\)$/);
                assert.match(stage.style.transform, /translate3d\(/);
                assert.match(stage.style.transform, /rotateY\(/);
                assert.match(shadow.style.transform, /^translate3d\(-/);
                assert.equal(rafCallbacks.size, 0, "stops scheduling rAF after proximity convergence");

                // Full hover at the right edge of .screen.
                screen.dispatchEvent(
                    new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 640, clientY: 420 })
                );
                await flushFrames();
                assert.match(stage.style.transform, /translate3d\(0,-8\.00px,0\)/);
                assert.match(stage.style.transform, /rotateY\(4\.500deg\)/);
                assert.match(shadow.style.transform, /^translate3d\(-31\.5px,/);
                assert.equal(rim.classList.contains("lit"), true);
                assert.equal(parseFloat(rim.style.opacity), 1);
                assert.equal(rafCallbacks.size, 0, "stops scheduling rAF after hover convergence");

                // Hovering .controls levels the stage flat while keeping the rim lit.
                controls.dispatchEvent(
                    new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 320, clientY: 620 })
                );
                await flushFrames();
                assert.equal(stage.style.transform, "");
                assert.equal(rim.classList.contains("lit"), true);
                assert.equal(rafCallbacks.size, 0);

                // Re-hover, converge, then wait for IDLE_MS (1800ms) to auto-level.
                screen.dispatchEvent(
                    new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 640, clientY: 420 })
                );
                const hoveredAt = clock.now();
                await flushFrames();
                assert.match(stage.style.transform, /rotateY\(4\.500deg\)/);
                assert.equal(rafCallbacks.size, 0);
                await clock.advance(Math.max(0, 1820 - (clock.now() - hoveredAt)));
                assert.ok(rafCallbacks.size > 0, "idle timer wakes rAF to level stage");
                await flushFrames();
                assert.equal(stage.style.transform, "");
                assert.equal(rim.classList.contains("lit"), true);
                assert.equal(rafCallbacks.size, 0);

                // Leaving the document fades the rim light out and stops rAF.
                view.document.documentElement.dispatchEvent(new view.window.MouseEvent("pointerleave"));
                await flushFrames();
                assert.equal(rim.classList.contains("lit"), false);
                assert.equal(rim.style.opacity, "");
                assert.equal(rafCallbacks.size, 0);
            }
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
}

async function testViewportScoping() {
    const clock = new FakeClock();
    let rafSeq = 0;
    const rafCallbacks = new Map();
    let floatNotify;
    const markup = `<html class="motion"><body>
<div class="clip-frame" id="near"><div class="clip-flight"><div class="float-shadow"></div><figure class="stage"><div class="screen"></div><div class="controls"></div><span class="clip-rim"><i class="clip-rim-glow"></i></span></figure></div></div>
<div class="clip-frame" id="far"><div class="clip-flight"><div class="float-shadow"></div><figure class="stage"><div class="screen"></div><div class="controls"></div><span class="clip-rim"><i class="clip-rim-glow"></i></span></figure></div></div>
</body></html>`;
    const view = render(
        markup,
        {},
        {
            beforeParse(window) {
                Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
                window.matchMedia = (query) => ({
                    matches: query !== "(prefers-reduced-motion: reduce)"
                });
                window.IntersectionObserver = class {
                    constructor(notify, options) {
                        if (options?.rootMargin === "500px 0px") floatNotify = notify;
                    }
                    observe() {}
                    unobserve() {}
                };
                window.setTimeout = clock.schedule;
                window.clearTimeout = clock.cancel;
                window.performance.now = clock.now;
                window.requestAnimationFrame = (update) => {
                    const id = ++rafSeq;
                    rafCallbacks.set(id, update);
                    return id;
                };
                window.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
            }
        }
    );
    async function flushFrames(maxSteps = 250) {
        let count = 0;
        while (rafCallbacks.size > 0) {
            assert.ok(count++ < maxSteps, "animation loop did not converge");
            const batch = [...rafCallbacks.entries()];
            rafCallbacks.clear();
            await clock.advance(16);
            const now = clock.now();
            for (const [, update] of batch) update(now);
        }
    }
    try {
        const nearFrame = view.document.getElementById("near");
        const farFrame = view.document.getElementById("far");
        let nearReads = 0;
        let farReads = 0;
        const nearRect = { left: 0, top: 200, right: 640, bottom: 640, width: 640, height: 440 };
        const farRect = { left: 0, top: 2400, right: 640, bottom: 2840, width: 640, height: 440 };
        nearFrame.getBoundingClientRect = () => {
            nearReads++;
            return nearRect;
        };
        farFrame.getBoundingClientRect = () => {
            farReads++;
            return farRect;
        };

        view.window.eval(fs.readFileSync(path.join(__dirname, "../website/motion.js"), "utf8"));
        assert.ok(floatNotify, "float IntersectionObserver is registered");
        floatNotify([
            { target: nearFrame, isIntersecting: true, boundingClientRect: nearRect },
            { target: farFrame, isIntersecting: false, boundingClientRect: farRect }
        ]);
        await flushFrames();
        nearReads = 0;
        farReads = 0;

        nearFrame
            .querySelector(".screen")
            .dispatchEvent(new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 640, clientY: 420 }));
        await flushFrames();
        assert.ok(nearReads > 0);
        assert.equal(farReads, 0, "offscreen clip-frame never runs getBoundingClientRect");
        assert.match(nearFrame.querySelector(".stage").style.transform, /rotateY\(4\.500deg\)/);
        assert.equal(nearFrame.querySelector(".clip-rim").classList.contains("lit"), true);
        assert.equal(farFrame.querySelector(".stage").style.transform, "");
        assert.equal(farFrame.querySelector(".clip-rim").classList.contains("lit"), false);

        // Once the near card leaves the observer margin, rim clears and pointermove does not schedule rAF.
        floatNotify([{ target: nearFrame, isIntersecting: false, boundingClientRect: nearRect }]);
        assert.equal(nearFrame.querySelector(".clip-rim").classList.contains("lit"), false);
        nearReads = 0;
        view.window.dispatchEvent(
            new view.window.MouseEvent("pointermove", { bubbles: true, clientX: 320, clientY: 420 })
        );
        assert.equal(rafCallbacks.size, 0);
        assert.equal(nearReads, 0);
        view.assertHealthy();
    } finally {
        view.close();
    }
}

function testAmbientMotion() {
    const unobserved = [];
    let reveal;
    let hidden = false;
    const view = render(
        '<html class="motion"><body><div data-reveal data-ambient></div><div data-reveal></div></body></html>',
        {},
        {
            beforeParse(window) {
                window.matchMedia = () => ({ matches: false });
                window.IntersectionObserver = class {
                    constructor(notify, options) {
                        if (options.threshold === 0.12) reveal = notify;
                    }
                    observe() {}
                    unobserve(element) {
                        unobserved.push(element);
                    }
                };
                Object.defineProperty(window.document, "hidden", { get: () => hidden });
            }
        }
    );
    try {
        const [ambient, oneShot] = view.document.querySelectorAll("[data-reveal]");
        const entry = (target, intersectionRatio) => ({
            target,
            intersectionRatio,
            isIntersecting: intersectionRatio > 0
        });
        const playing = () => ambient.classList.contains("ambient-playing");
        view.window.eval(fs.readFileSync(path.join(__dirname, "../website/motion.js"), "utf8"));
        reveal([entry(ambient, 1), entry(oneShot, 1)]);
        assert.ok(ambient.classList.contains("shown") && playing());
        assert.deepStrictEqual(unobserved, [oneShot]);
        hidden = true;
        view.document.dispatchEvent(new view.window.Event("visibilitychange"));
        assert.equal(playing(), false);
        hidden = false;
        view.document.dispatchEvent(new view.window.Event("visibilitychange"));
        assert.equal(playing(), true);
        reveal([entry(ambient, 0.05)]);
        assert.equal(playing(), false);
        reveal([entry(ambient, 1)]);
        assert.equal(playing(), true);
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testClipPlayback() {
    const clock = new FakeClock();
    const observers = [];
    const reduced = { matches: false, addEventListener: () => {} };
    let hidden = false;
    const view = render(
        home("en", "1.2.3-test"),
        {},
        {
            beforeParse(window) {
                window.matchMedia = (query) =>
                    query.includes("reduced") ? reduced : { matches: true, addEventListener: () => {} };
                window.IntersectionObserver = class {
                    constructor(notify) {
                        observers.push(notify);
                    }
                    observe() {}
                    unobserve() {}
                };
                window.setTimeout = clock.schedule;
                window.clearTimeout = clock.cancel;
                window.performance.now = clock.now;
                Object.defineProperty(window.document, "hidden", { get: () => hidden });
                const playing = new Set();
                const media = window.HTMLMediaElement.prototype;
                Object.defineProperty(media, "paused", {
                    get: function () {
                        return !playing.has(this);
                    }
                });
                media.play = function () {
                    assert.equal(playing.size, 0, "only one recording should play");
                    playing.add(this);
                    return Promise.resolve();
                };
                media.pause = function () {
                    playing.delete(this);
                };
            }
        }
    );
    try {
        const [first, second, third] = [...view.document.querySelectorAll(".clip-frame")];
        const [firstVideo, secondVideo, thirdVideo] = [first, second, third].map((clip) => clip.querySelector("video"));
        let presentFirstFrame;
        thirdVideo.requestVideoFrameCallback = (callback) => {
            presentFirstFrame = callback;
            return 1;
        };
        view.window.eval(fs.readFileSync(path.join(__dirname, "../website/site.js"), "utf8"));
        const [near, visible] = observers;
        const entry = (target, ratio) => ({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 });
        near([entry(first, 1)]);
        assert.match(first.querySelector(".clip-poster").src, /-narrow\.webp$/);
        assert.equal(second.querySelector(".clip-poster").hasAttribute("src"), false, "narrow posters are also lazy");
        visible([entry(first, 0.8)]);
        visible([entry(first, 0), entry(second, 0.6), entry(third, 0.9)]);
        assert.ok([firstVideo, secondVideo, thirdVideo].every((video) => !video.hasAttribute("src")));
        await clock.advance(150);
        view.window.dispatchEvent(new view.window.Event("scroll"));
        await clock.advance(199);
        assert.equal(thirdVideo.hasAttribute("src"), false, "scrolling delays the pending video download");
        await clock.advance(1);
        assert.equal(thirdVideo.getAttribute("src"), thirdVideo.dataset.srcNarrow);
        assert.equal(thirdVideo.paused, false);
        assert.equal(firstVideo.hasAttribute("src") || secondVideo.hasAttribute("src"), false);
        thirdVideo.dispatchEvent(new view.window.Event("playing"));
        assert.equal(third.querySelector(".frame-ready"), null, "keep the poster until a frame is presented");
        presentFirstFrame();
        assert.ok(third.querySelector(".frame-ready"));

        const secondToggle = second.querySelector("[data-toggle]");
        secondToggle.click();
        assert.equal(secondVideo.paused, false, "manual playback starts immediately");
        assert.equal(thirdVideo.paused, true);
        secondVideo.dispatchEvent(new view.window.Event("playing"));
        assert.ok(second.querySelector(".frame-ready"), "playing reveals the video without frame callback support");
        visible([entry(first, 1)]);
        secondToggle.click();
        assert.equal(secondVideo.paused, true);
        assert.ok(second.querySelector(".frame-ready"), "pausing keeps the current frame on screen");
        assert.equal(firstVideo.hasAttribute("src"), false, "pausing does not immediately load another recording");
        secondToggle.click();
        hidden = true;
        view.document.dispatchEvent(new view.window.Event("visibilitychange"));
        assert.equal(secondVideo.paused, true);
        hidden = false;
        reduced.matches = true;
        visible([entry(second, 0), entry(first, 1)]);
        await clock.advance(200);
        assert.equal(firstVideo.hasAttribute("src"), false, "reduced motion disables autoplay");
        first.querySelector("[data-toggle]").click();
        assert.equal(firstVideo.paused, false);
        view.assertHealthy();
    } finally {
        view.close();
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

function testInstallRedirect() {
    const installScript = fs.readFileSync(path.join(__dirname, "../website/install.js"), "utf8");
    const baseOrigin = new URL(origin);
    for (const lang of ["zh", "en"]) {
        const pagePath = lang === "en" ? "en/install/" : "install/";
        const pageUrl = new URL(pagePath, origin);
        const dom = new JSDOM(installPage(lang), { url: pageUrl.href });
        try {
            const doc = dom.window.document;
            assert.equal(doc.documentElement.lang, content[lang].htmlLang);
            assert.equal(doc.querySelector('meta[name="robots"]').getAttribute("content"), "noindex");
            assert.equal(doc.querySelector('link[rel="canonical"]').href, pageUrl.href);
            const noscript = doc.querySelector("noscript");
            assert.ok(noscript);
            assert.ok(noscript.innerHTML.includes('http-equiv="refresh"'));
            assert.ok(noscript.innerHTML.includes(`vscode:extension/${extensionId}`));

            const open = doc.getElementById("install-open");
            assert.equal(open.getAttribute("href"), `vscode:extension/${extensionId}`);
            const [, marketplace] = doc.querySelectorAll(".install-actions a");
            assert.equal(marketplace.href, `https://marketplace.visualstudio.com/items?itemName=${extensionId}`);
            assert.ok(doc.querySelector(".install-command code").textContent.includes(`ext install ${extensionId}`));

            for (const element of doc.querySelectorAll("link[href], script[src], img[src], a[href]")) {
                const raw = element.getAttribute("href") || element.getAttribute("src");
                if (raw.startsWith("vscode:") || raw.startsWith("https://marketplace.visualstudio.com/")) continue;
                const resolved = new URL(raw, pageUrl);
                assert.equal(resolved.origin, baseOrigin.origin);
                assert.ok(resolved.pathname.startsWith(baseOrigin.pathname), `${pagePath}: escapes base ${raw}`);
            }
        } finally {
            dom.window.close();
        }
    }

    const markup = installPage("zh").replace(/<script [^>]+><\/script>/g, "");
    for (const mode of ["desktop", "mobile-ua", "coarse-touch"]) {
        let clicks = 0;
        const view = render(
            markup,
            {},
            {
                url: origin + "install/",
                beforeParse(window) {
                    if (mode === "mobile-ua") {
                        Object.defineProperty(window.navigator, "userAgent", {
                            value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                            configurable: true
                        });
                    }
                    window.matchMedia = (query) => ({
                        matches: mode === "coarse-touch" && query.includes("pointer: coarse")
                    });
                }
            }
        );
        try {
            view.document.getElementById("install-open").addEventListener("click", (event) => {
                event.preventDefault();
                clicks++;
            });
            view.window.eval(installScript);
            assert.equal(clicks, mode === "desktop" ? 1 : 0, mode);
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
    scenario("setup groups targets by vendor, and flashing and writing have distinct demos", testChapterPresentation);
    scenario(
        "hero uses one complete screenshot and the probe list indicates more interfaces",
        testHeroAndSupportPresentation
    );
    scenario("every chapter has its recording and matching steps", testChaptersMatchRecordings);
    scenario("sampling is one themed zone with modes, states, tiled types and stills", testSamplingZone);
    scenario(
        "Agent clients have local logos and both languages show the complete MCP catalogue",
        testAgentCapabilities
    );
    await scenario(
        "hero and clip tilt respond on desktop and respect narrow, touch and reduced motion",
        testPointerMotion
    );
    await scenario("floating animation only measures and updates clip-frames near the viewport", testViewportScoping);
    scenario("sampling loops pause outside the viewport and in background tabs", testAmbientMotion);
    await scenario("clip posters and video are lazy, with one active recording", testClipPlayback);
    scenario("guided tour targets exist in the real pages", testTourTargetsExist);
    scenario("the font subset covers both pages and the tour", testFontsCoverPages);
    scenario("demo validates language and resets without changing stored preferences", testDemoReset);
    scenario("install redirect pages launch VS Code on desktop and keep fallbacks", testInstallRedirect);
    await scenario("preview serves project paths and rejects invalid paths", testServer);
    console.log("Website regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
