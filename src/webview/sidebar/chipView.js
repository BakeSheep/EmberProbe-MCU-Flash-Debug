"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChipView = factory();
})(globalThis, function () {
    function chipEsc(t) {
        return String(t == null ? "" : t).replace(
            /[&<>"']/g,
            (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
        );
    }
    function chipStat(label, value) {
        return value
            ? '<div class="chip-stat"><span class="chip-k">' +
                  label +
                  '</span><span class="chip-v" title="' +
                  chipEsc(value) +
                  '">' +
                  chipEsc(value) +
                  "</span></div>"
            : "";
    }
    function chipProbe(info) {
        return [info.probeName || info.probe, info.transport].filter(Boolean).join(" · ");
    }
    function render(info, { t, icon: CHIP_ICON, states: CHIP_STATE_TEXT, moreOpen: chipMoreOpen }) {
        info = info || {};
        function chipRow(k, v, opt) {
            opt = opt || {};
            if (!v && !opt.always) return "";
            const cls = opt.muted ? " muted" : "";
            const copy = opt.copy
                ? '<button class="chip-copy" data-copy="' + chipEsc(opt.copy) + '">' + t("common.copy") + "</button>"
                : "";
            return (
                '<div class="chip-row"><span class="k">' +
                k +
                '</span><span class="v' +
                cls +
                '" title="' +
                chipEsc(v || "—") +
                '">' +
                chipEsc(v || "—") +
                "</span>" +
                copy +
                "</div>"
            );
        }
        const core = info.core || t("chip.unknownCore");
        const compat =
            info.authenticity === "compatible"
                ? t("chip.authCompat", { vendor: info.compatBrand || info.compatVendor || t("chip.vendorUnmarked") })
                : info.authenticity === "genuine"
                  ? t("chip.authGenuine")
                  : "";
        const sub =
            (info.chip || info.series || info.targetName || "—") +
            (info.authenticity === "compatible" ? " · " + t("chip.compatTag") : "");
        const stt = CHIP_STATE_TEXT[info.targetState] || info.targetState || "—";
        const grid = [
            chipStat(t("chip.adapterClock"), info.clock),
            chipStat(t("chip.designer"), info.designer),
            chipStat(t("chip.targetState"), stt),
            chipStat(t("chip.debugProbe"), chipProbe(info))
        ].join("");
        const en = info.endian
            ? info.endian === "little"
                ? t("chip.endianLE")
                : info.endian === "big"
                  ? t("chip.endianBE")
                  : info.endian
            : "";
        const jep = info.designerCode
            ? (info.romDesigner ? info.romDesigner + " · " : "") + info.designerCode.replace(/^JEP106\s*/, "")
            : "";
        const g1 =
            [
                chipRow(t("chip.coreRev"), info.coreRevision),
                chipRow(t("chip.deviceId"), info.deviceId),
                chipRow(t("chip.revId"), info.revId),
                chipRow(t("chip.designer"), info.designer),
                chipRow("JEP106", jep),
                chipRow(t("chip.authenticity"), compat),
                chipRow(t("chip.romPart"), info.romPart),
                chipRow(t("chip.flashSize"), info.flashSize),
                chipRow(t("chip.endian"), en),
                chipRow(t("chip.uid"), info.uid, { copy: info.uid })
            ].join("") || chipRow(t("chip.info"), t("chip.openocdNoData"), { always: true, muted: true });
        const dbg = [info.probeName, info.probeVersion].filter(Boolean).join(" ") || info.probe;
        const g2 = [
            chipRow(t("chip.debugger"), dbg),
            chipRow(t("chip.transport"), info.transport),
            chipRow(t("chip.adapterClock"), info.clock),
            chipRow(t("chip.targetVoltage"), info.voltage || t("chip.voltageUnsupported"), {
                always: true,
                muted: !info.voltage
            }),
            chipRow(t("chip.target"), info.targetName)
        ].join("");
        let g3;
        if (info.targetState === "halted") {
            g3 = [
                chipRow(t("chip.targetState"), stt, { always: true }),
                chipRow(t("chip.haltReason"), info.haltReason),
                chipRow("PC", info.pc),
                chipRow("SP", info.sp),
                chipRow("LR", info.lr)
            ].join("");
        } else {
            g3 = [
                chipRow(t("chip.targetState"), stt, { always: true }),
                chipRow(t("chip.regInfo"), t("chip.regHint"), { always: true, muted: true })
            ].join("");
        }
        const groups =
            '<div class="chip-group"><div class="chip-group-title">' +
            t("chip.groupChip") +
            '</div><div class="chip-rows">' +
            g1 +
            '</div></div><div class="chip-group"><div class="chip-group-title">' +
            t("chip.groupDebug") +
            '</div><div class="chip-rows">' +
            g2 +
            '</div></div><div class="chip-group"><div class="chip-group-title">' +
            t("chip.groupRun") +
            '</div><div class="chip-rows">' +
            g3 +
            "</div></div>";
        return (
            '<div class="chip-hero">' +
            CHIP_ICON +
            '<div class="chip-hero-copy"><div class="chip-hero-core">' +
            chipEsc(core) +
            '</div><div class="chip-hero-sub" title="' +
            chipEsc(sub) +
            '">' +
            chipEsc(sub) +
            '</div></div></div><div class="chip-stats">' +
            grid +
            '</div><details class="chip-more"' +
            (chipMoreOpen ? " open" : "") +
            ' id="chipMore"><summary>' +
            t("chip.details") +
            "</summary>" +
            groups +
            "</details>"
        );
    }
    return { render };
});
