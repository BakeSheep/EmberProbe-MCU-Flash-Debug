"use strict";

// Self-contained so the fallback webview CSV exporter can serialize the same formatter.
// Integer-ms times keep the legacy `.mmmZ` text; sub-ms times add three microsecond digits.
function createSampleTimeFormatter() {
    let second = NaN,
        prefix = "";
    return (t) => {
        if (!(t >= 0 && t < 253402300800000)) return new Date(t).toISOString();
        let whole = Math.floor(t / 1000);
        let micros = Math.round((t - whole * 1000) * 1000);
        if (micros >= 1000000) {
            whole++;
            micros -= 1000000;
        }
        if (whole !== second) {
            second = whole;
            prefix = new Date(whole * 1000).toISOString().slice(0, 20);
        }
        const text = String(micros % 1000 === 0 ? micros / 1000 : micros);
        return prefix + "000000".slice(0, (micros % 1000 === 0 ? 3 : 6) - text.length) + text + "Z";
    };
}

module.exports = { createSampleTimeFormatter };
