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
    const legacy = ["#4FC1FF", "#F14C4C", "#73C991", "#FFCC00", "#C586C0", "#CE9178", "#569CD6", "#DCDCAA"];
    const lines = ["solid", "dashed", "dotted"];
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
    function legacyColor(i) {
        return legacy[i] || hsl((i * 47) % 360);
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
        for (const [name, style] of Object.entries(record || {}))
            if (validName(name) && valid(style)) result[name] = { color: style.color, line: style.line };
        return result;
    }
    function rgb(color) {
        return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    }
    function allocate(record) {
        const used = Object.values(record).filter(valid),
            index = used.length;
        const free = palette.find((color) => !used.some((s) => s.color.toLowerCase() === color.toLowerCase()));
        let color = free;
        if (!color) {
            let best = -1;
            for (let hue = 0; hue < 360; hue += 7) {
                const candidate = hsl(hue, 0.65, 0.46),
                    channels = rgb(candidate);
                const distance = Math.min(
                    ...used.map((s) => rgb(s.color).reduce((sum, v, i) => sum + (v - channels[i]) ** 2, 0))
                );
                if (distance > best) {
                    best = distance;
                    color = candidate;
                }
            }
        }
        return { color, line: lines[Math.floor(index / palette.length) % lines.length] };
    }
    function ensure(record, name) {
        if (!Object.prototype.hasOwnProperty.call(record, name)) record[name] = allocate(record);
        return record[name];
    }
    function dash(line) {
        return line === "dashed" ? [8, 4] : line === "dotted" ? [2, 4] : [];
    }
    return { palette, lines, legacyColor, validName, valid, clean, allocate, ensure, dash };
});
