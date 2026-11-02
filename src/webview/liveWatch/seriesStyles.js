"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSeriesStyles = factory();
})(globalThis, function () {
    const palette = [
        "#1684C5",
        "#CE4242",
        "#22855A",
        "#B47900",
        "#AA55AE",
        "#AD6547",
        "#526DC6",
        "#858523",
        "#C54386",
        "#178B91",
        "#8059C3",
        "#CC681B"
    ];
    const lines = ["solid", "dashed", "dotted"];
    const preview = Object.freeze({ color: "#808080", line: "solid" });
    function hsl(h, s = 0.65, l = 0.6) {
        const a = s * Math.min(l, 1 - l);
        return (
            "#" +
            [0, 8, 4]
                .map((n) => {
                    const k = (n + h / 30) % 12;
                    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
                        .toString(16)
                        .padStart(2, "0");
                })
                .join("")
        );
    }
    function validName(name) {
        return typeof name === "string" && name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f]/.test(name);
    }
    function valid(style) {
        return (
            !!style &&
            typeof style.color === "string" &&
            /^#[0-9a-f]{6}$/i.test(style.color) &&
            lines.includes(style.line)
        );
    }
    function clean(record) {
        const result = Object.create(null);
        for (const [name, style] of Object.entries(record || {}).slice(0, 4096))
            if (validName(name) && valid(style)) result[name] = { color: style.color, line: style.line };
        return result;
    }
    function rgb(color) {
        return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    }
    // Extend the original colors with farthest candidates at two readable lightness levels.
    const candidates = [];
    for (let hue = 0; hue < 360; hue += 7)
        for (const lightness of [0.36, 0.5]) candidates.push(hsl(hue, 0.7, lightness));
    while (palette.length < 48) {
        const channels = palette.map(rgb);
        let best = -1,
            color;
        for (const candidate of candidates) {
            const values = rgb(candidate);
            const distance = Math.min(
                ...channels.map((used) => used.reduce((sum, value, i) => sum + (value - values[i]) ** 2, 0))
            );
            if (distance > best) {
                best = distance;
                color = candidate;
            }
        }
        palette.push(color);
    }
    function identity(style) {
        return style.color.toLowerCase() + ":" + style.line;
    }
    function allocate(record) {
        const used = new Set(Object.values(record).filter(valid).map(identity));
        for (const line of lines)
            for (const color of palette) if (!used.has(identity({ color, line }))) return { color, line };
        // Beyond the 144 presets, use a deterministic full-period RGB sequence without repeating a pair.
        for (let index = 0; ; index++) {
            const color = "#" + ((0x204060 + index * 0x9e3779) & 0xffffff).toString(16).padStart(6, "0");
            const style = { color, line: "solid" };
            if (!used.has(identity(style))) return style;
        }
    }
    function ensure(record, name) {
        if (!Object.prototype.hasOwnProperty.call(record, name)) record[name] = allocate(record);
        return record[name];
    }
    function active(overrides, names, previous = {}, watchedNames = names) {
        const watched = new Set(watchedNames);
        names = [...new Set([...names, ...Object.keys(previous).filter((name) => watched.has(name))])];
        const result = Object.create(null),
            used = new Set();
        for (const name of names)
            if (Object.hasOwn(overrides, name) && valid(overrides[name])) {
                result[name] = overrides[name];
                used.add(identity(result[name]));
            }
        for (const name of names)
            if (!Object.hasOwn(result, name) && Object.hasOwn(previous, name) && valid(previous[name])) {
                const key = identity(previous[name]);
                if (!used.has(key)) {
                    result[name] = previous[name];
                    used.add(key);
                }
            }
        for (const name of names) ensure(result, name);
        return result;
    }
    function dash(line) {
        return line === "dashed" ? [8, 4] : line === "dotted" ? [2, 4] : [];
    }
    return { palette, lines, preview, validName, valid, clean, allocate, ensure, active, dash };
});
