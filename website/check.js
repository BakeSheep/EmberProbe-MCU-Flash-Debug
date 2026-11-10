"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { buildSite } = require("./build");
const { origin } = require("./template");

function checkSite(directory) {
    const base = new URL(origin);
    let references = 0;
    for (const name of ["index.html", "en/index.html", "demo/index.html", "demo/editor/index.html"]) {
        const dom = new JSDOM(fs.readFileSync(path.join(directory, name), "utf8"));
        const document = dom.window.document;
        assert.ok(document.title, `${name}: missing title`);
        const linked = "[src], [srcset], [poster], [data-poster], [data-poster-narrow], link[href], a[href]";
        const links = [...document.querySelectorAll(linked)].flatMap((element) =>
            ["src", "href", "poster", "data-poster", "data-poster-narrow", "srcset"]
                .map((name) => element.getAttribute(name))
                .filter(Boolean)
                // A srcset lists "url width" candidates; each url is checked.
                .flatMap((value) => value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]))
        );
        for (const link of links) {
            if (link.startsWith("data:")) continue;
            const resolved = new URL(link, new URL(name, base));
            if (resolved.origin !== base.origin) continue;
            assert.ok(resolved.pathname.startsWith(base.pathname), `${name}: resource escapes project base: ${link}`);
            let relative = decodeURIComponent(resolved.pathname.slice(base.pathname.length));
            if (!relative || relative.endsWith("/")) relative += "index.html";
            const target = path.join(directory, relative);
            assert.ok(fs.existsSync(target), `${name}: missing resource ${link}`);
            if (resolved.hash && relative === name)
                assert.ok(document.getElementById(resolved.hash.slice(1)), `${name}: missing anchor ${link}`);
            references++;
        }
        for (const img of document.querySelectorAll("img"))
            assert.ok(img.hasAttribute("alt"), `${name}: missing image alternative`);
        dom.window.close();
    }
    return references;
}

if (require.main === module) console.log(`Website checked: ${checkSite(buildSite())} local references`);
module.exports = { checkSite };
