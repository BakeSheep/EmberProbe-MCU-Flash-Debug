"use strict";

(() => {
    const language = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh";
    const c = JSON.parse(document.getElementById("demo-translations").textContent)[language];
    const editor = document.getElementById("demo-editor");
    const source = `editor/?lang=${language}&theme=light`;
    document.documentElement.lang = c.htmlLang;
    document.title = c.demoTitle;
    document.body.dataset.lang = language;
    for (const [id, key] of Object.entries({
        "back-label": "back",
        "simulation-label": "simulation",
        "reset-demo": "reset",
        "demo-help": "demoHelp",
        "mobile-hint": "mobileHint",
        standalone: "standalone",
        "demo-language": "language"
    }))
        document.getElementById(id).textContent = c[key];
    document.getElementById("demo-back").href = language === "en" ? "../en/" : "../";
    document.getElementById("demo-language").href = `?lang=${language === "en" ? "zh" : "en"}`;
    document.getElementById("standalone").href = source;
    editor.title = c.demoTitle;
    if (editor.getAttribute("src") !== source) editor.src = source;
    document.getElementById("reset-demo").addEventListener("click", () => {
        // Replacing the frame discards all hosts, samples, pending debug starts and edited values.
        // Do not clear localStorage: other mockup tabs may be using the stored theme or background.
        const current = document.getElementById("demo-editor");
        const fresh = current.cloneNode(false);
        fresh.src = source;
        current.replaceWith(fresh);
    });
})();
