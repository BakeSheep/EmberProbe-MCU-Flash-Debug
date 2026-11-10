"use strict";

const fs = require("fs");
const path = require("path");
const { content, links, agentClients, mcpTools } = require("./content");

const origin = "https://bakesheep.github.io/EmberProbe-MCU-Flash-Debug/";
const timeline = JSON.parse(fs.readFileSync(path.join(__dirname, "assets/media/timeline.json"), "utf8"));
const escape = (value) =>
    String(value).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

// Set before first paint, so what animates in never flashes at its final position.
const MOTION_FLAG = `<script>if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("motion")</script>`;

function head(lang, prefix, demo = false) {
    const c = content[lang];
    const canonical = origin + (demo ? "demo/" : lang === "en" ? "en/" : "");
    const hero = `${prefix}assets/media/hero-${lang}`;
    const preload = demo
        ? ""
        : `<link rel="preload" as="image" href="${hero}.webp" media="(min-width: 761px)" fetchpriority="high"><link rel="preload" as="image" href="${hero}-narrow.webp" media="(max-width: 760px)" fetchpriority="high">`;
    // Without motion.js nothing would reveal what the flag hides.
    const motion = demo
        ? ""
        : `<script src="${prefix}assets/motion.js" defer onerror="document.documentElement.classList.remove('motion')"></script>`;
    return `<!doctype html><html lang="${c.htmlLang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(demo ? c.demoTitle : c.title)}</title><meta name="description" content="${escape(c.description)}">
<meta name="theme-color" content="#ffffff"><link rel="icon" href="${prefix}assets/icon.png">
<link rel="canonical" href="${canonical}">
${demo ? '<meta name="robots" content="noindex">' : `<link rel="alternate" hreflang="zh-CN" href="${origin}"><link rel="alternate" hreflang="en" href="${origin}en/"><link rel="alternate" hreflang="x-default" href="${origin}">`}
<meta property="og:type" content="website"><meta property="og:title" content="${escape(c.title)}"><meta property="og:description" content="${escape(c.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${origin}assets/media/og-${lang}.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<link rel="preload" as="font" type="font/woff2" href="${prefix}assets/fonts/inter.woff2" crossorigin>${preload}
<link rel="stylesheet" href="${prefix}assets/site.css">${demo ? "" : MOTION_FLAG}${demo ? `<script src="${prefix}assets/tour-data.js" defer></script>` : ""}<script src="${prefix}assets/${demo ? "demo" : "site"}.js" defer></script>${motion}</head>`;
}

// A clip stays unloaded until it nears the viewport; site.js picks the poster and starts it.
function clip(c, prefix, lang, scene, alt) {
    const data = timeline[scene];
    const file = `${prefix}assets/media/${scene}-${lang}`;
    const narrow = data.narrow ? `<source src="${file}-narrow.mp4" media="(max-width: 760px)" type="video/mp4">` : "";
    const poster = `data-poster="${file}.webp"`;
    const narrowPoster = data.narrow ? `data-poster-narrow="${file}-narrow.webp"` : "";
    const size = data.narrow || [data.width, data.height];
    return `<div class="float" data-float><div class="float-shadow" aria-hidden="true"></div><figure class="stage" data-clip data-steps="${data.steps.join(",")}" data-duration="${data.duration}" style="--clip-narrow: ${size[0]} / ${size[1]}; --clip: ${data.width} / ${data.height}">
<div class="screen"><video muted loop playsinline preload="none" ${poster} ${narrowPoster} width="${data.width}" height="${data.height}" aria-label="${escape(alt)}">${narrow}<source src="${file}.mp4" type="video/mp4"></video></div>
<div class="controls"><button type="button" class="toggle" data-toggle data-play="${c.player.play}" data-pause="${c.player.pause}">${c.player.play}</button><div class="progress" aria-hidden="true">${data.steps.map((start, i) => `<span style="flex-grow:${(data.steps[i + 1] ?? data.duration) - start}"><i></i></span>`).join("")}</div><button type="button" class="enlarge" data-enlarge data-enter="${c.player.enlarge}" data-exit="${c.player.exit}">${c.player.enlarge}</button></div></figure></div>`;
}

// A chapter's side says what the visitor gets: short points, or for setup the probes and chips it works with.
function chapterSide(section) {
    if (section.support) {
        const { title, probes, chips, systems, note } = section.support;
        const group = (item, i, more = true) =>
            `<div class="support-group" data-reveal style="--i:${i}"><h4>${escape(item.label)}</h4><ul class="pills">${item.items.map((name) => `<li>${escape(name)}</li>`).join("")}${more ? '<li aria-hidden="true">…</li>' : ""}</ul></div>`;
        return `<div class="chapter-side support"><h3 class="support-title" data-reveal>${escape(title)}</h3>${group(probes, 1)}${group(chips, 2)}${group(systems, 3, false)}<p class="support-note" data-reveal style="--i:4">${escape(note)}</p></div>`;
    }
    if (!section.points?.length) return "";
    return `<div class="chapter-side"><ul class="points" style="--count:${section.points.length}">${section.points.map(([title, text], i) => `<li data-reveal style="--i:${i}"><strong>${escape(title)}</strong><span>${escape(text)}</span></li>`).join("")}</ul></div>`;
}

function chapter(c, prefix, lang, section) {
    const side = chapterSide(section);
    return `<section class="chapter${section.wide ? " wide" : ""}" id="${section.id}"><div class="wrap"><header class="chapter-head" data-reveal><h2>${escape(section.title)}</h2><p>${escape(section.lead)}</p></header>
<div class="chapter-body${side ? "" : " solo"}">${clip(c, prefix, lang, section.id, section.alt)}
${side}</div>${section.id === "agent" ? agentDetail(c.agent, prefix) : ""}</div></section>`;
}

// A cropped still of the real UI at the size it was recorded, so its text matches the frontend's.
function still(prefix, lang, id, alt) {
    const size = timeline[id][lang];
    return `<img src="${prefix}assets/media/${id}-${lang}.webp" width="${size.width}" height="${size.height}" alt="${escape(alt)}" loading="lazy" decoding="async">`;
}

// A smooth swing for the decorative scope trace.
const wave = (t) =>
    Math.sin(2 * Math.PI * 3 * t) +
    0.42 * Math.sin(2 * Math.PI * 17 * t + 0.6) +
    0.26 * Math.sin(2 * Math.PI * 41 * t + 1.3);

// A decorative trace across the zone's opening, drawn like a scope sweep.
function scopeTrace() {
    const width = 1200;
    const points = Array.from({ length: 241 }, (_, i) => {
        const t = i / 240;
        const envelope = 0.55 + 0.45 * Math.sin(Math.PI * t);
        return [t * width, 40 - wave(t * 0.6 + 0.1) * 18 * envelope];
    });
    const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    // With motion, a sweep runs along the trace: a brighter copy of it shows through a band that moves with a cursor.
    const band = `<linearGradient id="scope-fade"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient><mask id="scope-sweep" maskUnits="userSpaceOnUse" x="-300" y="-20" width="${width + 600}" height="120"><rect class="scope-band" x="-260" y="-20" width="260" height="120" fill="url(#scope-fade)"/></mask>`;
    return `<div class="scope" aria-hidden="true" data-reveal><svg viewBox="0 0 ${width} 80" preserveAspectRatio="none"><defs>${band}</defs><path class="scope-glow" d="${d}"/><path class="scope-trace" pathLength="1" d="${d}"/><path class="scope-hot" mask="url(#scope-sweep)" d="${d}"/></svg><span class="scope-cursor"></span></div>`;
}

const listItems = (items) =>
    items
        .map(
            ([title, text], i) =>
                `<li data-reveal style="--i:${i}"><strong>${escape(title)}</strong><span>${escape(text)}</span></li>`
        )
        .join("");

const FEATURE_ICONS = {
    setup: '<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
    flash: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    watch: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
    debug: '<path d="M5 4v16l15-8z"/><path d="M2 4v16"/>',
    peripherals:
        '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
    cubemx: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    data: '<path d="M4 4h16v16H4zM8 8h8M8 12h4M8 16h6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    hidden: '<path d="m3 3 18 18M10 5c5-1 10 7 10 7l-3 4M6 6l-4 6s5 8 11 7m-3-9a3 3 0 0 0 4 4"/>',
    record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'
};

const featureIcon = (id) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FEATURE_ICONS[id]}</svg>`;

// Matched data, history and window rows make the two modes directly comparable.
function modeCard(prefix, lang, card, index) {
    const facts = card.facts
        .map(
            ([label, value, text], i) =>
                `<div><dt>${featureIcon(["data", "history", "window"][i])}${escape(label)}</dt><dd><strong>${escape(value)}</strong><span>${escape(text)}</span></dd></div>`
        )
        .join("");
    return `<article class="mode-card mode-${card.kind}" data-reveal style="--i:${index}"><div class="mode-shot shot-frame">${still(prefix, lang, card.shot, card.alt)}</div>
<div class="mode-copy"><header><h4>${escape(card.name)}</h4><p class="mode-fit">${escape(card.fit)}</p></header><p class="mode-rate"><strong>${escape(card.rate)}</strong><span>${escape(card.rateNote)}</span></p><dl class="mode-facts">${facts}</dl></div></article>`;
}

function silentSampling(silent) {
    return `<aside class="mode-silent" aria-labelledby="silent-title"><div><h4 id="silent-title">${escape(silent.title)}<span>${escape(silent.scope)}</span></h4><p>${escape(silent.text)}</p></div><ol class="silent-flow">${silent.steps.map((step, i) => `<li>${featureIcon(["hidden", "record", "history"][i])}<span>${escape(step)}</span></li>`).join("")}</ol></aside>`;
}

// One mark per target state: a free-running trace, the debugger's Continue, a breakpoint.
const STATE_ICONS = [
    '<path d="M2 12c2.5 0 2.5-7 5-7s2.5 14 5 14 2.5-14 5-14 2.5 7 5 7" pathLength="1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M4 4v16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M9 4.5v15l11-7.5z" fill="currentColor"/>',
    '<circle cx="12" cy="12" r="7" fill="currentColor"/>'
];

// The three target states, each its own clip, alternating sides along a rail.
function samplingStates(c, prefix, lang, states) {
    const rows = states.items
        .map(
            (item, i) =>
                `<li class="state state-${i + 1}"><div class="state-copy" data-reveal><span class="state-mark" aria-hidden="true"><svg viewBox="0 0 24 24">${STATE_ICONS[i]}</svg></span><p class="state-index">${String(i + 1).padStart(2, "0")}</p><h4>${escape(item.name)}</h4><p class="state-tag">${escape(item.tag)}</p><p class="state-text">${escape(item.text)}</p></div>
<div class="state-clip">${clip(c, prefix, lang, item.id, item.alt)}</div></li>`
        )
        .join("");
    return `<ol class="states">${rows}</ol>`;
}

// The type stills, tiled in two columns split where their heights balance, so nothing needs a click.
function typeGrid(prefix, lang, gallery) {
    const heights = gallery.map((item) => timeline[item.id][lang].height + 140);
    const total = heights.reduce((sum, height) => sum + height, 0);
    let split = 1;
    let best = Infinity;
    for (let k = 1, left = 0; k < gallery.length; k++) {
        left += heights[k - 1];
        if (Math.abs(total - 2 * left) < best) [best, split] = [Math.abs(total - 2 * left), k];
    }
    const card = (item, i) =>
        `<li class="type-card" data-reveal style="--i:${i % 3}"><h4>${escape(item.name)}</h4><p>${escape(item.text)}</p><div class="shot-frame">${still(prefix, lang, item.id, item.alt)}</div></li>`;
    const column = (items, offset) =>
        `<ul class="type-col">${items.map((item, i) => card(item, i + offset)).join("")}</ul>`;
    return `<div class="type-grid">${column(gallery.slice(0, split), 0)}${column(gallery.slice(split), 1)}</div>`;
}

// The sampling chapter groups scenarios, target states, variable types and plotting.
function samplingZone(c, prefix, lang, section) {
    const { zone } = section;
    const { modes, states, types, chart } = zone;
    const partHead = (part) =>
        `<header class="part-head" data-reveal><h3>${escape(part.title)}</h3><p>${escape(part.lead)}</p></header>`;
    const stats = zone.stats
        .map(
            ([value, label], i) =>
                `<li data-reveal style="--i:${i}"><strong>${escape(value)}</strong><span>${escape(label)}</span></li>`
        )
        .join("");
    const features = chart.features
        .map(
            ([title, text], i) =>
                `<li data-reveal style="--i:${i % 3}"><strong>${escape(title)}</strong><span>${escape(text)}</span></li>`
        )
        .join("");
    const shots = chart.shots
        .map(
            (shot, i) =>
                `<figure class="chart-shot" data-reveal style="--i:${i}"><div class="shot-frame">${still(prefix, lang, shot.id, shot.alt)}</div></figure>`
        )
        .join("");
    return `<section class="chapter zone zone-sampling" id="${section.id}"><div class="zone-bg" aria-hidden="true"></div>
<div class="wrap zone-intro"><header class="zone-head"><h2 data-reveal>${escape(zone.title)}</h2><p class="zone-lead" data-reveal style="--i:1">${escape(zone.lead)}</p></header>${scopeTrace()}<ul class="zone-stats">${stats}</ul></div>
<div class="zone-part" id="${modes.id}"><div class="wrap">${partHead(modes)}<div class="mode-cards">${modes.cards.map((card, i) => modeCard(prefix, lang, card, i)).join("")}</div>${silentSampling(modes.silent)}</div></div>
<div class="zone-part" id="${states.id}"><div class="wrap">${partHead(states)}${samplingStates(c, prefix, lang, states)}</div></div>
<div class="zone-part" id="${types.id}"><div class="wrap">${partHead(types)}<div class="chapter-body">${clip(c, prefix, lang, "variables", types.alt)}<div class="chapter-side"><ul class="points">${listItems(types.points)}</ul></div></div>${typeGrid(prefix, lang, types.gallery)}</div></div>
<div class="zone-part" id="${chart.id}"><div class="wrap">${partHead(chart)}<div class="chapter-body wide-body">${clip(c, prefix, lang, "waveform", chart.alt)}</div><ul class="feature-grid">${features}</ul><div class="chart-shots">${shots}</div></div></div>
</section>`;
}

function agentDetail(agent, prefix) {
    const clients = agentClients
        .map(
            ([id, name]) =>
                `<li><img src="${prefix}assets/clients/${id}.svg" width="40" height="40" alt="" loading="lazy" decoding="async"><span>${escape(name)}</span></li>`
        )
        .join("");
    const cards = agent.groups
        .map(([id, title, text, members]) => {
            const tools = members.flatMap((member) => mcpTools[member]);
            const capabilities = members.map((member) => agent.capabilities.find(([key]) => key === member));
            return `<article class="capability-card capability-${id}"><header><span class="capability-icon">${featureIcon(id)}</span><span class="capability-count">${tools.length} ${escape(agent.toolsLabel)}</span></header><h4>${escape(title)}</h4><p>${escape(text)}</p><ul class="capability-tags">${capabilities.map(([, name]) => `<li>${escape(name)}</li>`).join("")}</ul><details class="capability-tools"><summary>${escape(agent.detailsLabel)}<span aria-hidden="true">+</span></summary>${capabilities.map(([key, name, description]) => `<div class="capability-tool-group"><h5>${escape(name)}</h5><p>${escape(description)}</p><ul>${mcpTools[key].map((tool) => `<li><code>${escape(tool)}</code></li>`).join("")}</ul></div>`).join("")}</details></article>`;
        })
        .join("");
    return `<div class="agent-detail"><section class="agent-clients" aria-labelledby="agent-clients-title"><h3 id="agent-clients-title">${escape(agent.clientsTitle)}</h3><ul class="client-logos">${clients}</ul><p class="agent-note">${escape(agent.clientsNote)}</p></section>
<section class="agent-capabilities" aria-labelledby="agent-capabilities-title"><h3 id="agent-capabilities-title">${escape(agent.capabilitiesTitle)}</h3><div class="capability-grid">${cards}</div><p class="agent-note">${escape(agent.permissionNote)}</p></section></div>`;
}

// motion.js turns the grid into a deck that scrolling moves through: cards wait stacked on the right, pass through
// the middle, and settle stacked on the left. Without it the cards stay a plain grid.
function toolsChapter(c, prefix, lang) {
    const tools = c.tools;
    const cards = tools.items
        .map(
            (tool, i) =>
                `<article class="tool" data-card style="--i:${i}"><div class="tool-copy"><h3>${escape(tool.title)}</h3><p class="tool-lead">${escape(tool.lead)}</p></div>${clip(c, prefix, lang, tool.id, tool.alt)}</article>`
        )
        .join("");
    const dots = tools.items
        .map((tool, i) => `<button type="button" data-dot="${i}" aria-label="${escape(tool.title)}"><i></i></button>`)
        .join("");
    return `<section class="chapter tools" id="${tools.id}"><div class="wrap"><header class="chapter-head" data-reveal><h2>${escape(tools.title)}</h2><p>${escape(tools.lead)}</p></header></div>
<div class="tool-track" data-deck style="--count:${tools.items.length}"><div class="tool-deck"><div class="wrap"><div class="tool-grid">${cards}</div><div class="deck-dots" aria-hidden="true">${dots}</div></div></div></div></section>`;
}

// The first image is a single still of the real UI.
function heroVisual(c, prefix, lang) {
    const data = timeline.hero;
    const file = `${prefix}assets/media/hero-${lang}`;
    return `<figure class="hero-visual"><div class="hero-scene" data-hero-scene><div class="hero-glow" aria-hidden="true"></div><div class="hero-card" data-hero-card style="--shot:${data.width} / ${data.height}; --shot-narrow:${data.narrow[0]} / ${data.narrow[1]}"><picture><source media="(max-width: 760px)" srcset="${file}-narrow.webp"><img src="${file}.webp" width="${data.width}" height="${data.height}" alt="${escape(c.heroAlt)}" fetchpriority="high"></picture></div></div></figure>`;
}

function heroCopy(c, links, demo) {
    const letters = [..."EmberProbe"].map((letter, i) => `<span style="--i:${i}">${letter}</span>`).join("");
    return `<div class="hero-copy"><p class="eyebrow" data-reveal>${escape(c.eyebrow)}</p><h1><span class="visually-hidden">EmberProbe</span><span class="title-letters" aria-hidden="true">${letters}</span></h1><p class="subtitle" data-reveal style="--i:3">${escape(c.subtitle)}</p>
<div class="hero-actions" data-reveal style="--i:5"><a class="button primary" href="${links.install}">${c.install}</a><a class="button" href="${demo}">${c.tour}</a></div></div>`;
}

function requirementsChapter(c, guide) {
    const spec = c.requirements;
    return `<section class="chapter" id="${spec.id}"><div class="wrap"><header class="chapter-head" data-reveal><h2>${escape(spec.title)}</h2></header>
<div class="spec-grid"><table class="spec" data-reveal><tbody>${spec.rows.map(([key, value]) => `<tr><th scope="row">${escape(key)}</th><td>${escape(value)}</td></tr>`).join("")}</tbody></table>
<div class="start"><h3 data-reveal>${escape(spec.startTitle)}</h3><ol>${spec.start.map(([title, text], i) => `<li data-reveal style="--i:${i}"><span class="number">${i + 1}</span><span class="step-copy"><strong>${escape(title)}</strong><span>${escape(text)}</span></span></li>`).join("")}</ol>
<div class="start-actions" data-reveal><a class="button primary" href="${links.install}">${c.install}</a><a class="button" href="${guide}">${escape(spec.guide)}</a></div></div></div></div></section>`;
}

function home(lang, version) {
    const c = content[lang];
    const prefix = lang === "en" ? "../" : "./";
    const demo = `${prefix}demo/?lang=${lang}`;
    return `${head(lang, prefix)}<body>
<a class="skip" href="#main">${c.skip}</a>
<header class="header"><div class="wrap header-row"><a class="brand" href="${lang === "en" ? "./" : prefix}"><img src="${prefix}assets/icon.png" width="24" height="24" alt="">EmberProbe</a>
<nav aria-label="${c.navLabel}"><i class="nav-marker" aria-hidden="true"></i>${[...c.chapters, c.tools, c.requirements].map((s) => `<a href="#${s.id}">${s.nav}</a>`).join("")}</nav>
<div class="header-links"><a data-language href="${lang === "en" ? "../" : "./en/"}" lang="${lang === "en" ? "zh-CN" : "en"}">${c.language}</a><a href="${links.github}">GitHub</a></div></div><i class="scroll-progress" aria-hidden="true"></i></header>
<main id="main">
<section class="hero" data-hero><div class="hero-grid" aria-hidden="true"></div><div class="wrap hero-row">${heroCopy(c, links, demo)}${heroVisual(c, prefix, lang)}</div></section>
${c.chapters.map((section) => (section.zone ? samplingZone(c, prefix, lang, section) : chapter(c, prefix, lang, section))).join("\n")}
${toolsChapter(c, prefix, lang)}
${requirementsChapter(c, lang === "en" ? links.docsEn : links.docs)}
</main>
<footer class="footer"><div class="wrap footer-row"><p>EmberProbe v${escape(version)}<span>${c.notice}</span></p>
<nav aria-label="${c.projectLabel}"><a href="${links.github}">${c.source}</a><a href="${links.github}/releases">${c.releases}</a><a href="${links.github}/issues">${c.issues}</a><a href="${links.github}/blob/master/LICENSE">${c.license}</a><a href="${prefix}credits.txt">Credits</a></nav></div></footer>
</body></html>`;
}

// demo.js fills the page in for the language in the URL, so every language shares this one file.
function demoPage(lang = "zh") {
    const c = content[lang];
    const names = [
        "htmlLang",
        "demoTitle",
        "back",
        "simulation",
        "language",
        "reset",
        "tourTitle",
        "tourExit",
        "tourResume",
        "tourPreparing",
        "tourSkip",
        "tourNext",
        "tourNextChapter",
        "tourChapterDone",
        "tourAllDone",
        "mobileHint",
        "mobileLink"
    ];
    const translations = Object.fromEntries(
        Object.entries(content).map(([key, value]) => [
            key,
            Object.fromEntries(names.map((name) => [name, value[name]]))
        ])
    );
    return `${head(lang, "../", true)}<body class="demo-page" data-lang="${lang}"><header class="demo-header"><a class="brand" id="demo-back" href="${lang === "en" ? "../en/" : "../"}"><img src="../assets/icon.png" width="24" height="24" alt="">EmberProbe<span id="back-label">${c.back}</span></a><span id="simulation-label">${c.simulation}</span><div><button type="button" id="tour-resume">${c.tourResume}</button><a id="demo-language" href="?lang=${lang === "en" ? "zh" : "en"}">${c.language}</a><button type="button" id="reset-demo">${c.reset}</button></div></header><main><aside class="tour" aria-labelledby="tour-heading"><div class="tour-head"><h1 id="tour-heading">${c.tourTitle}</h1><button type="button" id="tour-exit">${c.tourExit}</button></div><ol id="tour-chapters"></ol></aside><div class="mobile-note"><p id="mobile-hint">${c.mobileHint}</p><a id="mobile-link" href="${lang === "en" ? "../en/" : "../"}">${c.mobileLink}</a></div><div class="editor-stage" id="editor-stage"><div class="editor-scroll"><iframe id="demo-editor" title="${c.demoTitle}" src="editor/?lang=${lang}&amp;theme=light" allow="clipboard-write"></iframe></div><div class="tour-layer" aria-hidden="true"><i id="tour-spot" hidden></i></div><p class="tour-wait" id="tour-preparing">${c.tourPreparing}</p></div><noscript>${c.noScript}</noscript></main><script type="application/json" id="demo-translations">${JSON.stringify(translations)}</script></body></html>`;
}

module.exports = { home, demoPage, origin };
