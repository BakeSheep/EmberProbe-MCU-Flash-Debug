"use strict";

(() => {
    const link = document.getElementById("install-open");
    if (!link) return;
    const target = link.getAttribute("href");
    if (!target || !target.startsWith("vscode:extension/")) return;
    // Skip automatic custom-protocol navigation on mobile devices where desktop VS Code is absent.
    const mobile =
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
        (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false);
    if (!mobile) link.click();
})();
