"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSamplingRateMotion = factory();
})(globalThis, function () {
    function clamp(value) {
        return Math.min(1, Math.max(0, value));
    }
    // Broad, low-contrast light fields keep the gradient continuous rather than forming small colour islands.
    // Coordinates are measured in track heights, so a wave expands as a circle rather than an ellipse.
    function paint(pixels, width, height, seconds) {
        if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width < 1 ||
            height < 1 ||
            width > 384 ||
            height > 64 ||
            pixels.length !== width * height * 4 ||
            !Number.isFinite(seconds)
        )
            return false;
        const t = Math.max(0, seconds);
        const aspect = width / height;
        const progress = clamp(t / 1.2);
        const radius = (aspect + 0.8) * Math.pow(progress, 1.25);
        const glowCentre = 0.54 + Math.sin(t * 0.65) * 0.12;
        let offset = 0;
        for (let y = 0; y < height; y++) {
            const v = (y + 0.5) / height - 0.5;
            for (let x = 0; x < width; x++) {
                const u = (x + 0.5) / height;
                const horizontal = u / aspect;
                const dx = aspect - 0.35 - u;
                const distance = Math.hypot(dx, v);
                // Circular waves span most of the track, with no hard crests or repeated narrow bands.
                const wave = Math.sin((distance / aspect) * 6.4 - t * 2.1);
                const drift = horizontal - glowCentre + v * 0.055 * Math.sin(t * 0.8);
                const glow = Math.exp(-(drift * drift) / 0.12);
                const tone = horizontal * horizontal * (3 - 2 * horizontal);
                const light = wave * 4 + glow * 13 - v * v * 3;
                const edge = Math.sin(v * 3 + t * 1.8) * 0.055;
                const coverage = clamp((radius - distance + edge) / 0.85);
                const alpha = coverage * coverage * (3 - 2 * coverage);
                pixels[offset++] = 76 + tone * 48 + glow * 30 + light;
                pixels[offset++] = 105 - tone * 16 + glow * 8 + light;
                pixels[offset++] = 232 - tone * 10 + light;
                pixels[offset++] = Math.round(alpha * 255);
            }
        }
        return true;
    }
    return { paint };
});
