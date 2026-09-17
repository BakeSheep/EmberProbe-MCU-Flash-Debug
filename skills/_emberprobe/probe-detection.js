"use strict";

function probeCandidates(inventory) {
    const text = String(inventory || "");
    return [
        [/st[- ]?link|stm32\s+stlink/i, "stlink.cfg"],
        [/j[- ]?link|segger/i, "jlink.cfg"],
        [/cmsis(?:[- _]?dap)|daplink|pico\s?probe|mcu[- ]?link/i, "cmsis-dap.cfg"],
        [/xds[- ]?110/i, "xds110.cfg"],
        [/nu[- ]?link/i, "nulink.cfg"]
    ]
        .filter(([pattern]) => /** @type {RegExp} */ (pattern).test(text))
        .map(([, name]) => String(name));
}

function probeFromText(text) {
    const candidates = probeCandidates(text);
    return candidates.length === 1 ? candidates[0] : "";
}

module.exports = { probeCandidates, probeFromText };
