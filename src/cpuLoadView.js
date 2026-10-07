"use strict";

function cpuLoadHtml(tr) {
    const text = (key) =>
        String(tr(key)).replace(
            /[&<>"']/g,
            (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
        );
    // The sidebar translates again on language changes, not on its initial render.
    return `<section class="other-block" id="experimentalFeaturesBlock" aria-labelledby="experimentalFeaturesTitle">
    <div class="other-block-head"><strong id="experimentalFeaturesTitle" data-i18n="cpu.experimentalFeatures">${text("cpu.experimentalFeatures")}</strong>
    <button id="cpuLoadToggle" class="cpu-sampling-toggle" type="button" aria-pressed="false"
    title="${text("cpu.startHint")}" aria-label="${text("cpu.startHint")}">
    <svg class="cpu-toggle-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
    <svg class="cpu-toggle-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg></button></div>
    <div id="cpuLoadRow" class="memory-region cpu-load-inline" role="status">
    <span class="cpu-inline-label"><strong data-i18n="cpu.title">${text("cpu.title")}</strong>
    <span class="cpu-inline-badge cpu-inline-coverage"><span data-i18n="cpu.coverage">${text("cpu.coverage")}</span>: <span id="cpuCoverage">—</span></span></span>
    <span id="cpuWorkload" class="cpu-inline-value" aria-live="polite">—</span>
    <progress id="cpuLoadProgress" max="100" value="0" aria-hidden="true"></progress></div></section>`;
}

module.exports = { cpuLoadHtml };
