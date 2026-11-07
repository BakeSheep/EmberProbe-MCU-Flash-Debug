"use strict";

const fs = require("fs");
const path = require("path");
const { content, links } = require("./content");

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
    const preload = demo
        ? ""
        : `<link rel="preload" as="image" href="${prefix}assets/media/hero-${lang}.webp" fetchpriority="high">`;
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
function clip(c, prefix, lang, scene, alt, eager) {
    const data = timeline[scene];
    const file = `${prefix}assets/media/${scene}-${lang}`;
    const narrow = data.narrow ? `<source src="${file}-narrow.mp4" media="(max-width: 760px)" type="video/mp4">` : "";
    const poster = eager ? `poster="${file}.webp"` : `data-poster="${file}.webp"`;
    const narrowPoster = data.narrow ? `data-poster-narrow="${file}-narrow.webp"` : "";
    const size = data.narrow || [data.width, data.height];
    return `<div class="float" data-float="${eager ? "hero" : "chapter"}"><div class="float-shadow" aria-hidden="true"></div><figure class="stage" data-clip data-steps="${data.steps.join(",")}" data-duration="${data.duration}" style="--clip-narrow: ${size[0]} / ${size[1]}; --clip: ${data.width} / ${data.height}">
<div class="screen"><video muted loop playsinline preload="none" ${poster} ${narrowPoster} width="${data.width}" height="${data.height}" aria-label="${escape(alt)}">${narrow}<source src="${file}.mp4" type="video/mp4"></video></div>
<div class="controls"><button type="button" class="toggle" data-toggle data-play="${c.player.play}" data-pause="${c.player.pause}">${c.player.play}</button><div class="progress" aria-hidden="true">${data.steps.map((start, i) => `<span style="flex-grow:${(data.steps[i + 1] ?? data.duration) - start}"><i></i></span>`).join("")}</div><button type="button" class="enlarge" data-enlarge data-enter="${c.player.enlarge}" data-exit="${c.player.exit}">${c.player.enlarge}</button></div></figure></div>`;
}

function chapter(c, prefix, lang, section) {
    const count = section.steps.length;
    return `<section class="chapter${section.wide ? " wide" : ""}" id="${section.id}"><div class="wrap"><header class="chapter-head" data-reveal><h2>${escape(section.title)}</h2><p>${escape(section.lead)}</p></header>
<div class="chapter-body" data-chapter>${clip(c, prefix, lang, section.id, section.alt)}
<div class="chapter-side"><ol class="steps" style="--count:${count}">${section.steps.map(([title, text], i) => `<li data-reveal style="--i:${i}"><button type="button" data-seek="${i}"><span class="number">${i + 1}</span><span class="step-copy"><strong>${escape(title)}</strong><span>${escape(text)}</span></span></button></li>`).join("")}</ol><p class="limit" data-reveal style="--i:${count}">${escape(section.limit)}</p></div></div>${section.id === "agent" ? agentDetail(c.agent) : ""}</div></section>`;
}

// Not a client's interface: tool names are real, the layout belongs to this page and carries a visible label.
function talkRow(agent, row, index) {
    const label = `<span class="talk-role">${escape(agent.roles[row.role])}</span>`;
    const name = row.name ? `<code>${escape(row.name)}</code>` : "";
    const text = row.text ? `<p>${escape(row.text)}</p>` : "";
    const rows = row.rows
        ? `<dl>${row.rows.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>`
        : "";
    return `<li class="talk-row talk-${row.role}" data-reveal style="--i:${index}">${label}<div class="talk-body">${name}${text}${rows}</div></li>`;
}

function agentDetail(agent) {
    return `<div class="agent-detail"><figure class="talk"><figcaption><span class="talk-tag">${escape(agent.sample)}</span>${escape(agent.caption)}</figcaption><ol>${agent.talk.map((row, index) => talkRow(agent, row, index)).join("")}</ol></figure>
<dl class="facts">${agent.facts.map(([key, value], i) => `<div data-reveal style="--i:${i}"><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl></div>`;
}

function toolsChapter(c, prefix, lang) {
    const tools = c.tools;
    return `<section class="chapter" id="${tools.id}"><div class="wrap"><header class="chapter-head" data-reveal><h2>${escape(tools.title)}</h2><p>${escape(tools.lead)}</p></header>
<div class="tool-grid">${tools.items.map((tool) => `<article class="tool"><h3 data-reveal>${escape(tool.title)}</h3><p class="tool-lead" data-reveal>${escape(tool.lead)}</p>${clip(c, prefix, lang, tool.id, tool.alt)}<p class="limit" data-reveal>${escape(tool.limit)}</p></article>`).join("")}</div></div></section>`;
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
<section class="hero"><div class="hero-grid" aria-hidden="true"></div><div class="wrap"><div class="hero-head"><div><h1 data-reveal>${escape(c.headline)}</h1><p data-reveal style="--i:1">${escape(c.intro)}</p></div>
<div class="hero-actions" data-reveal style="--i:2"><a class="button primary" href="${links.install}">${c.install}</a><a class="button" href="${demo}">${c.tour}</a></div></div>
${clip(c, prefix, lang, "hero", c.heroAlt, true)}<p class="notice">${c.notice}</p></div></section>
${c.chapters.map((section) => chapter(c, prefix, lang, section)).join("\n")}
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
