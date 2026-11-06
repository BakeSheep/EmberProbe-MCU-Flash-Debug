"use strict";

(() => {
    const state = {
        scene: 0,
        frozen: false,
        target: 1200,
        sample: 1200,
        phase: 0,
        frame: 0,
        previous: 0,
        visible: false
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mobile = window.matchMedia("(max-width: 760px)");
    const tabs = [...document.querySelectorAll("[data-step]")];
    const scenes = [...document.querySelectorAll("[data-scene]")];
    const steps = [...document.querySelectorAll("[data-flow]")];
    function showScene(index) {
        state.scene = index;
        tabs.forEach((tab, i) => tab.setAttribute("aria-pressed", String(i === index)));
        scenes.forEach((scene, i) => {
            scene.hidden = i !== index;
        });
    }
    tabs.forEach((tab, index) =>
        tab.addEventListener("click", () => {
            showScene(index);
            steps[index].scrollIntoView({ behavior: reduced.matches ? "instant" : "smooth", block: "center" });
        })
    );
    function syncStep() {
        if (mobile.matches) return;
        const center = window.innerHeight * 0.5;
        let nearest = 0;
        let distance = Infinity;
        steps.forEach((step, index) => {
            const rect = step.getBoundingClientRect();
            const next = Math.abs(rect.top + rect.height / 2 - center);
            if (next < distance) {
                nearest = index;
                distance = next;
            }
        });
        if (nearest !== state.scene) showScene(nearest);
    }
    let scrollFrame = 0;
    function scheduleStep() {
        if (!scrollFrame)
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                syncStep();
            });
    }
    window.addEventListener("scroll", scheduleStep, { passive: true });
    window.addEventListener("resize", scheduleStep);
    syncStep();
    const language = document.querySelector("[data-language]");
    language.addEventListener("click", () => {
        const destination = new URL(language.href);
        destination.hash = window.location.hash;
        language.href = destination.href;
    });

    const dialog = document.getElementById("lightbox");
    document.querySelectorAll("[data-enlarge]").forEach((button) =>
        button.addEventListener("click", () => {
            const source = button.querySelector("img");
            dialog.querySelector("img").src = source.src;
            dialog.querySelector("img").alt = source.alt;
            dialog.querySelector("p").textContent = source.alt;
            dialog.showModal();
        })
    );
    dialog.querySelector("button").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
    });

    const slider = document.getElementById("target");
    const freeze = document.getElementById("freeze");
    const line = document.getElementById("wave-line");
    const area = document.getElementById("wave-area");
    function paint() {
        const base = 170 - ((state.target - 600) / 1800) * 135;
        const points = [];
        for (let x = 0; x <= 560; x += 4) {
            const y = base + Math.sin(x / 31 + state.phase) * 13 + Math.sin(x / 13 + state.phase * 0.7) * 3;
            points.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(2)}`);
        }
        line.setAttribute("d", points.join(" "));
        area.setAttribute("d", `${points.join(" ")} L560 200 L0 200Z`);
        document.getElementById("measured").textContent = Math.round(state.sample).toLocaleString(
            document.documentElement.lang
        );
    }
    function animate(now) {
        state.frame = 0;
        const delta = Math.min((now - (state.previous || now)) / 1000, 0.1);
        state.previous = now;
        state.phase += delta * 1.5;
        state.sample += (state.target + Math.sin(state.phase) * 8 - state.sample) * Math.min(1, delta * 3);
        paint();
        state.frame = requestAnimationFrame(animate);
    }
    function updateMotion() {
        cancelAnimationFrame(state.frame);
        state.frame = 0;
        state.previous = 0;
        if (!document.hidden && state.visible && !state.frozen && !reduced.matches)
            state.frame = requestAnimationFrame(animate);
    }
    slider.addEventListener("input", () => {
        state.target = Number(slider.value);
        document.getElementById("target-value").textContent = slider.value;
        document.getElementById("readback").textContent = slider.value;
        if (!state.frozen && reduced.matches) {
            state.sample = state.target;
            paint();
        }
    });
    freeze.addEventListener("click", () => {
        state.frozen = !state.frozen;
        freeze.setAttribute("aria-pressed", String(state.frozen));
        freeze.textContent = state.frozen ? freeze.dataset.resume : freeze.dataset.freeze;
        if (!state.frozen && reduced.matches) {
            state.sample = state.target;
            paint();
        }
        updateMotion();
    });
    document.addEventListener("visibilitychange", updateMotion);
    reduced.addEventListener("change", updateMotion);
    if ("IntersectionObserver" in window) {
        new IntersectionObserver(([entry]) => {
            state.visible = entry.isIntersecting;
            updateMotion();
        }).observe(document.querySelector(".signal-panel"));
    } else {
        state.visible = true;
        updateMotion();
    }
    paint();
})();
