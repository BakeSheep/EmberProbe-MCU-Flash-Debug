"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

for (const lang of ["en", "zh"]) {
    const view = render(getLiveWatchContent({ panelId: 2 }, lang));
    try {
        const { document: doc, window } = view;
        const input = doc.getElementById("frequency");
        const slider = doc.getElementById("frequencyPreset");
        const toggle = doc.getElementById("frequencyToggle");
        const popup = doc.getElementById("frequencyPopup");
        const track = doc.getElementById("frequencySlider");
        const pointer = (type, id = 1) => {
            const event = new window.MouseEvent(type, { button: 0, bubbles: true });
            Object.defineProperty(event, "pointerId", { value: id });
            slider.dispatchEvent(event);
        };
        const settings = () => view.messages.filter((m) => ["setFrequency", "setUnlimitedSampling"].includes(m.type));
        const choose = (index) => {
            slider.value = String(index);
            slider.dispatchEvent(new window.Event("input"));
        };
        const commit = (value) => {
            input.value = value;
            input.dispatchEvent(new window.Event("change"));
        };
        assert.strictEqual(
            doc.getElementById("frequencyLabel").textContent,
            lang === "zh" ? "采样帧率" : "Sampling rate"
        );
        assert.strictEqual(doc.getElementById("unlimited"), null);
        assert.strictEqual(
            doc.querySelector(".frequency-unit").parentElement.id,
            "frequencyPicker",
            "Hz is outside the input border"
        );
        assert(popup.hidden);
        assert.strictEqual(slider.max, "3");
        assert.strictEqual(doc.getElementById("frequencyTicks").children.length, 4);
        assert.strictEqual(popup.textContent, "", "the popup contains only the track and ticks");
        toggle.click();
        assert(!popup.hidden);
        assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
        assert.strictEqual(doc.activeElement, slider);
        for (const [index, hz] of [20, 50, 100, 200].entries()) {
            choose(index);
            assert.strictEqual(input.value, String(hz));
            assert.strictEqual(slider.getAttribute("aria-valuetext"), hz + " Hz");
            assert.deepStrictEqual(view.messages.at(-1), { type: "setFrequency", frequencyHz: hz, panelId: 2 });
        }
        slider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert(popup.hidden);
        assert.strictEqual(doc.activeElement, toggle);
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true }));
        assert(!popup.hidden);
        doc.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
        assert(popup.hidden);
        toggle.click();
        doc.getElementById("run").focus();
        assert(popup.hidden, "Tab out closes the popover");

        assert.strictEqual(slider.step, "1", "pointer motion switches at discrete preset thresholds");
        toggle.click();
        let count = settings().length;
        pointer("pointerdown");
        choose(1.35);
        assert.strictEqual(slider.value, "1");
        assert(Math.abs(Number(track.style.getPropertyValue("--frequency-position")) - 1 / 3) < 1e-9);
        assert.strictEqual(input.value, "50", "the thumb, fill and input all stay at the selected stop");
        choose(1.49);
        assert.strictEqual(input.value, "50", "no movement before crossing the midpoint");
        choose(1.51);
        assert.strictEqual(input.value, "100", "crossing the midpoint advances one stop");
        assert.strictEqual(slider.value, "2");
        choose(1.35);
        assert.strictEqual(settings().length, count, "dragging does not submit intermediate configurations");
        view.send({ type: "liveFrequency", frequencyHz: 200, intervalMs: 5 });
        view.send({ type: "liveStatus", running: false, unlimitedActive: false });
        assert.strictEqual(slider.value, "1", "host updates cannot change the selected drag stop");
        assert.strictEqual(input.value, "50");
        pointer("pointerup", 2);
        assert(track.classList.contains("is-dragging"), "ignore other pointers");
        pointer("pointerup");
        assert(!track.classList.contains("is-dragging"));
        assert.strictEqual(slider.value, "1");
        assert.strictEqual(input.value, "50");
        assert.strictEqual(settings().length, count + 1, "release commits exactly once");
        for (const end of ["pointercancel", "lostpointercapture"]) {
            count = settings().length;
            pointer("pointerdown");
            choose(2.2);
            pointer(end);
            assert.strictEqual(input.value, "50");
            assert.strictEqual(slider.value, "1");
            assert.strictEqual(settings().length, count, "cancel restores the committed value without a write");
        }
        pointer("pointerdown");
        choose(2.2);
        slider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert(popup.hidden);
        assert.strictEqual(input.value, "50");
        assert(!track.classList.contains("is-dragging"));
        slider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
        assert.strictEqual(input.value, "100", "keyboard changes still advance a full preset");

        commit("45.67");
        assert.strictEqual(input.value, "45.7");
        assert.strictEqual(slider.value, "1", "custom rates map to the nearest preset without changing the input");
        for (const bad of ["", "bad", "Infinity", "-1"]) {
            commit(bad);
            assert.strictEqual(input.value, "45.7", "invalid input retains the last finite target");
        }
        commit("500");
        assert.strictEqual(input.value, "200");
        commit("0.01");
        assert.strictEqual(input.value, "0.1");
        assert(!view.messages.some((m) => m.type === "setUnlimitedSampling"), "finite edits do not enable unlimited");

        view.send({ type: "liveUnlimited", available: true, enabled: false });
        assert.strictEqual(slider.max, "4");
        assert.strictEqual(doc.getElementById("frequencyTicks").children.length, 5);
        count = settings().length;
        pointer("pointerdown");
        choose(3.8);
        assert.strictEqual(input.value, "-");
        assert.strictEqual(slider.value, "4");
        assert.strictEqual(settings().length, count, "unlimited also waits for release");
        pointer("pointerup");
        assert.strictEqual(input.value, "-");
        assert(track.classList.contains("is-unlimited"));
        assert(!doc.getElementById("frequencyField").classList.contains("is-unlimited"));
        assert.strictEqual(track.style.getPropertyValue("--frequency-position"), "1");
        assert.deepStrictEqual(view.messages.at(-1), { type: "setUnlimitedSampling", enabled: true, panelId: 2 });
        view.send({ type: "liveUnlimited", available: true, enabled: true });
        view.send({ type: "liveFrequency", frequencyHz: 100, intervalMs: 10 });
        assert.strictEqual(input.value, "-", "finite fallback updates do not overwrite unlimited display");
        view.send({ type: "watchList", items: [{ name: "counter", type: "u32", address: 0x20000000 }] });
        doc.getElementById("run").click();
        assert.strictEqual(input.value, "-");
        assert.strictEqual(view.messages.at(-1).type, "start");
        assert.strictEqual(
            view.messages.at(-1).frequencyHz,
            100,
            "the host receives a finite debug fallback, never '-'"
        );
        input.focus();
        input.value = "75";
        view.send({ type: "liveStatus", unlimitedActive: true, actualHz: 600, running: true });
        assert.strictEqual(input.value, "75", "telemetry does not interrupt a numeric edit");
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
        assert.deepStrictEqual(view.messages.slice(-2), [
            { type: "setUnlimitedSampling", enabled: false, panelId: 2 },
            { type: "setFrequency", frequencyHz: 75, panelId: 2 }
        ]);
        assert(!track.classList.contains("is-unlimited"));
        choose(4);
        choose(1);
        assert.strictEqual(input.value, "50");
        assert.strictEqual(slider.value, "1");
        assert.deepStrictEqual(view.messages.slice(-2), [
            { type: "setUnlimitedSampling", enabled: false, panelId: 2 },
            { type: "setFrequency", frequencyHz: 50, panelId: 2 }
        ]);
        view.send({ type: "liveUnlimited", available: false, enabled: true });
        assert.strictEqual(slider.max, "3", "host capability revocation removes the extra stop");
        assert.strictEqual(input.value, "50");
        assert(!track.classList.contains("is-unlimited"));
        view.send({ type: "liveUnlimited", available: true, enabled: true });
        view.send({ type: "setLang", lang: lang === "zh" ? "en" : "zh" });
        assert.strictEqual(input.value, "-");
        assert.strictEqual(slider.getAttribute("aria-valuetext"), lang === "zh" ? "Max rate" : "不限速");
        // The local-history fallback must also discard old-rate timestamps on local and host changes.
        view.send({ type: "liveUnlimited", available: true, enabled: false });
        view.send({ type: "liveFrequency", frequencyHz: 200, intervalMs: 5 });
        const samples = (first, interval) =>
            view.send({
                type: "liveSample",
                samples: [first, first + interval].map((t) => ({ name: "rate-test", t, value: 1 }))
            });
        samples(1000, 5);
        assert.strictEqual(doc.getElementById("rate").textContent, "0.0kb/s | 200.0Hz");
        commit("20");
        samples(1050, 50);
        assert.strictEqual(doc.getElementById("rate").textContent, "0.0kb/s | 20.0Hz");
        view.send({ type: "liveFrequency", frequencyHz: 100, intervalMs: 10 });
        samples(1110, 10);
        assert.strictEqual(doc.getElementById("rate").textContent, "0.0kb/s | 100.0Hz");
        choose(4);
        samples(1121, 1);
        assert.strictEqual(doc.getElementById("rate").textContent, "0.0kb/s | 1000.0Hz");
        choose(3);
        samples(1127, 5);
        assert.strictEqual(doc.getElementById("rate").textContent, "0.0kb/s | 200.0Hz");
        view.assertHealthy();
    } finally {
        view.close();
    }
}
console.log("Sampling-rate presets, gated unlimited, editable fallback, popover focus and language tests passed");
