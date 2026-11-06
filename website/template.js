"use strict";

const { content, links } = require("./content");
const origin = "https://bakesheep.github.io/EmberProbe-MCU-Flash-Debug/";
const escape = (value) =>
    String(value).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
const lines = (value) => escape(value).replace(/\n/g, "<br>");

function head(lang, prefix, demo = false) {
    const c = content[lang];
    const canonical = origin + (demo ? "demo/" : lang === "en" ? "en/" : "");
    return `<!doctype html><html lang="${c.htmlLang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(demo ? c.demoTitle : c.title)}</title><meta name="description" content="${escape(c.description)}">
<meta name="theme-color" content="#faf9f6"><link rel="icon" href="${prefix}assets/icon.png">
<link rel="canonical" href="${canonical}">
${demo ? '<meta name="robots" content="noindex">' : `<link rel="alternate" hreflang="zh-CN" href="${origin}"><link rel="alternate" hreflang="en" href="${origin}en/"><link rel="alternate" hreflang="x-default" href="${origin}">`}
<meta property="og:type" content="website"><meta property="og:title" content="${escape(c.title)}"><meta property="og:description" content="${escape(c.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${origin}assets/wave-${lang}.png"><meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="${prefix}assets/site.css"><script src="${prefix}assets/${demo ? "demo" : "site"}.js" defer></script></head>`;
}

function picture(c, prefix, lang, name, alt, eager = false) {
    return `<button class="picture" data-enlarge aria-label="${c.zoom}: ${escape(alt)}"><img src="${prefix}assets/${name}-${lang}.png" alt="${escape(alt)}" width="1440" height="900" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></button>`;
}

function home(lang, version) {
    const c = content[lang];
    const prefix = lang === "en" ? "../" : "./";
    const demo = `${prefix}demo/?lang=${lang}`;
    const navIds = ["workflow", "live", "features", "start"];
    return `${head(lang, prefix)}<body>
<a class="skip" href="#main">${c.skip}</a>
<header class="header"><a class="brand" href="${lang === "en" ? "./" : prefix}" aria-label="EmberProbe"><img src="${prefix}assets/icon.png" width="34" height="34" alt="">EmberProbe<span class="brand-dot"></span></a>
<nav aria-label="${lang === "en" ? "Main navigation" : "主导航"}">${c.nav.map((n, i) => `<a href="#${navIds[i]}">${n}</a>`).join("")}</nav>
<div class="header-actions"><a data-language href="${lang === "en" ? "../" : "./en/"}" lang="${lang === "en" ? "zh-CN" : "en"}">${c.language}</a><a class="small-link" href="${links.github}">GitHub <span aria-hidden="true">↗</span></a></div></header>
<main id="main">
<section class="hero wrap"><div class="hero-copy"><a class="release" href="${links.github}/releases"><span></span>v${escape(version)}<span class="release-line"></span>${c.product}<span aria-hidden="true">↗</span></a>
<h1>${escape(c.headline[0])}<br><span>${escape(c.headline[1])}</span></h1><p class="intro">${c.intro}</p>
<div class="actions"><a class="button primary" href="${links.install}">${c.install}<span aria-hidden="true">↗</span></a><a class="button secondary" href="${demo}"><span class="play" aria-hidden="true">▷</span>${c.demo}</a></div>
<p class="eyebrow hero-meta">${c.eyebrow}</p></div>
<div class="hero-product"><div class="product-topline"><span class="status-dot"></span> EMBERPROBE / LIVE WATCH <span>${c.caption}</span></div>${picture(c, prefix, lang, "wave", c.steps[3].alt, true)}<div class="product-foot"><span>● ST-LINK</span><span>CORTEX-M4</span><span>main.c → ${lang === "en" ? "live data" : "实时数据"}</span></div></div>
<div class="capability-strip">${c.facts.map((f, i) => `<span><b>0${i + 1}</b>${f}</span>`).join("")}</div></section>
<section id="workflow" class="workflow wrap"><div class="section-heading"><p class="eyebrow">${c.flowLabel}</p><h2>${lines(c.flowTitle)}</h2><p>${c.flowIntro}</p></div>
<div class="workflow-layout"><div class="workflow-display"><div class="step-tabs" role="group" aria-label="${c.nav[0]}">${c.steps.map((s, i) => `<button data-step="${i}" aria-pressed="${i === 0}"><span>0${i + 1}</span>${s.title}</button>`).join("")}</div>
<div class="step-images">${c.steps.map((s, i) => `<figure data-scene="${i}" ${i ? "hidden" : ""}>${picture(c, prefix, lang, s.image, s.alt)}<figcaption><span class="status-dot"></span>${s.detail}</figcaption></figure>`).join("")}</div><p class="image-note">${c.caption}</p></div>
<div class="workflow-steps">${c.steps.map((s, i) => `<article class="flow-step" id="step-${i + 1}" data-flow="${i}"><span class="step-number">0${i + 1}</span><h3>${s.title}</h3><p>${s.text}</p><span class="step-detail">${s.detail}</span><div class="mobile-shot">${picture(c, prefix, lang, s.image, s.alt)}</div></article>`).join("")}</div></div></section>
<section id="live" class="live-section"><div class="wrap live-layout"><div class="live-copy"><p class="eyebrow">${c.liveLabel}</p><h2>${lines(c.liveTitle)}</h2><p>${c.liveIntro}</p><ul class="check-list">${c.liveNotes.map((n) => `<li>${n}</li>`).join("")}</ul><p class="fine-print">${c.liveLimit}</p></div>
<div class="signal-panel"><div class="signal-heading"><span><i class="status-dot"></i> LIVE WATCH</span><button id="freeze" data-freeze="${c.freeze}" data-resume="${c.resume}" aria-pressed="false">${c.freeze}</button></div><div class="signal-value"><span>${c.measured}</span><output id="measured">1,200</output><small>${c.rpm}</small></div>
<svg class="signal-chart" viewBox="0 0 560 200" role="img" aria-label="${c.illustration}"><defs><pattern id="grid" width="56" height="40" patternUnits="userSpaceOnUse"><path d="M 56 0 L 0 0 0 40" fill="none" stroke="#e5e1d9" stroke-width="1"/></pattern><linearGradient id="signal-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ec692b" stop-opacity=".16"/><stop offset="1" stop-color="#ec692b" stop-opacity="0"/></linearGradient></defs><rect width="560" height="200" fill="url(#grid)"/><path id="wave-area" fill="url(#signal-fill)" d="M0 110 Q70 20 140 110 T280 110 T420 110 T560 110 L560 200 L0 200Z"/><path id="wave-line" fill="none" stroke="#e9682d" stroke-width="2.5" d="M0 110 Q70 20 140 110 T280 110 T420 110 T560 110"/><path d="M0 100H560" stroke="#757f88" stroke-dasharray="4 6" opacity=".5"/></svg>
<div class="signal-control"><label for="target">g_target_rpm <span>${c.target}</span></label><div><input id="target" type="range" min="600" max="2400" value="1200" step="100"><output id="target-value" for="target">1200</output></div><p><span class="status-dot"></span>${c.verified}: <output id="readback">1200</output> <span class="signal-note">${c.illustration}</span></p></div></div></div></section>
<section id="features" class="features wrap"><div class="section-heading"><p class="eyebrow">${c.moreLabel}</p><h2>${lines(c.moreTitle)}</h2></div><div class="feature-grid">${c.features.map((f, i) => `<article class="feature"><div class="feature-copy"><span class="eyebrow">0${i + 1} / ${["PERIPHERALS", "RTOS", "MEMORY", "AGENT"][i]}</span><h3>${f.title}</h3><p>${f.text}</p></div>${picture(c, prefix, lang, f.image, f.alt)}</article>`).join("")}</div></section>
<section class="try-section wrap"><div class="try-copy"><p class="eyebrow">${c.tryLabel}</p><h2>${lines(c.tryTitle)}</h2><p>${c.tryText}</p><a class="button primary" href="${demo}">${c.demo}<span aria-hidden="true">↗</span></a></div><div class="try-visual">${picture(c, prefix, lang, "debug", c.steps[2].alt)}<span class="demo-stamp"><span class="status-dot"></span>${c.simulation}</span></div></section>
<section id="start" class="start-section wrap"><p class="eyebrow">${c.startLabel}</p><h2>${c.startTitle}</h2><div class="setup">${c.setup.map((s, i) => `<article><span class="step-number">0${i + 1}</span><h3>${s[0]}</h3><p>${s[1]}</p></article>`).join("")}</div><div class="actions"><a class="button primary" href="${links.install}">${c.install}<span aria-hidden="true">↗</span></a><a class="text-link" href="${links.docs}">${c.guide}<span aria-hidden="true"> →</span></a></div></section>
</main><footer class="footer wrap"><div><a class="brand" href="#"><img src="${prefix}assets/icon.png" width="28" height="28" alt="">EmberProbe</a><p>${c.footer}</p></div><nav aria-label="${lang === "en" ? "Project links" : "项目链接"}"><a href="${links.github}">${c.source}</a><a href="${links.github}/releases">${c.releases}</a><a href="${links.github}/issues">${c.issues}</a><a href="${links.github}/blob/master/LICENSE">${c.license}</a><a href="${prefix}credits.txt">Credits</a></nav></footer>
<dialog id="lightbox"><button class="lightbox-close" aria-label="${c.close}">×</button><img alt=""><p></p></dialog></body></html>`;
}

function demoPage(lang = "zh") {
    const c = content[lang];
    return `${head(lang, "../", true)}<body class="demo-page" data-lang="${lang}"><header class="demo-header"><a class="brand" id="demo-back" href="${lang === "en" ? "../en/" : "../"}"><img src="../assets/icon.png" width="28" height="28" alt="">EmberProbe<span id="back-label">${c.back}</span></a><strong id="simulation-label"><span class="status-dot"></span>${c.simulation}</strong><div><a id="demo-language" href="?lang=${lang === "en" ? "zh" : "en"}">${c.language}</a><button id="reset-demo">${c.reset}</button></div></header><main><div class="demo-instructions"><p id="demo-help">${c.demoHelp}</p><span id="mobile-hint">${c.mobileHint}</span><a id="standalone" href="editor/?lang=${lang}&amp;theme=light" target="_blank" rel="noopener">${c.standalone} ↗</a></div><div class="editor-scroll"><iframe id="demo-editor" title="${c.demoTitle}" src="editor/?lang=${lang}&amp;theme=light" allow="clipboard-write"></iframe></div><noscript>${c.noScript}</noscript></main><script type="application/json" id="demo-translations">${JSON.stringify(Object.fromEntries(Object.entries(content).map(([key, value]) => [key, Object.fromEntries(["htmlLang", "demoTitle", "back", "simulation", "language", "reset", "demoHelp", "mobileHint", "standalone"].map((name) => [name, value[name]]))])))}</script></body></html>`;
}

module.exports = { home, demoPage, origin };
