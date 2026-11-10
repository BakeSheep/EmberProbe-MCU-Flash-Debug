"use strict";

// Writes the social cards, assets/media/og-<lang>.jpg, from the built site. The hero still is the real UI.
// Needs `node website/build.js` first and the same LIB as record.js.
const path = require("path");
const { output } = require("../build");
const { createSiteServer, base } = require("../serve");
const { content } = require("../content");

const { chromium } = require(path.join(process.env.LIB || ".", "node_modules/playwright-core"));
const media = path.join(__dirname, "../assets/media");

const card = (lang) => `<!doctype html><html lang="${content[lang].htmlLang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="assets/site.css"><style>
body{width:1200px;height:630px;margin:0;overflow:hidden;background:#fff}
.title{position:absolute;left:64px;top:52px;display:flex;align-items:center;gap:12px;color:var(--ink);font-size:24px;font-weight:600}
h1{position:absolute;left:64px;top:104px;margin:0;color:var(--ink);font-size:48px;font-weight:600;line-height:1.2}
img.shot{position:absolute;left:64px;top:196px;width:1072px;border:1px solid var(--line);border-radius:10px}
</style></head><body><div class="title"><img src="assets/icon.png" width="36" height="36" alt="">EmberProbe</div>
<h1>${content[lang].subtitle}</h1><img class="shot" src="assets/media/hero-${lang}.webp" alt=""></body></html>`;

(async () => {
    const server = createSiteServer(output);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}${base}`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    for (const lang of ["zh", "en"]) {
        await page.route(`${url}card.html`, (route) => route.fulfill({ contentType: "text/html", body: card(lang) }));
        await page.goto(`${url}card.html`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(media, `og-${lang}.jpg`), type: "jpeg", quality: 90 });
        await page.unroute(`${url}card.html`);
    }
    await browser.close();
    server.close();
})();
