"use strict";

// Page motion: recordings float, tilt toward the pointer and settle as they scroll in. All of it is decoration:
// without JavaScript, or with reduced motion, the page renders flat and complete (see the "motion" class in <head>).
(() => {
    if (!document.documentElement.classList.contains("motion")) return;

    const MAX_TILT = 4.5; // degrees, with the pointer at a stage's edge
    const ENTRY_TILT = 12; // degrees, before a stage has scrolled in
    const ENTRY_LIFT = 56; // pixels
    const IDLE_MS = 1800; // A still pointer lets the stage go flat, where the recording's text is sharpest.
    const RIM_REACH = 180; // pixels around a stage where the rim light shows
    const TILT_REACH = 420; // pixels around a stage where the tilt fades out
    const HOVER_LIFT = 8; // pixels
    const STIFFNESS = 7;

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const pointer = { x: 0, y: 0, seen: false, moved: -Infinity, onControls: false };
    const grid = document.querySelector(".hero-grid");
    const hero = document.querySelector(".hero");
    const bar = document.querySelector(".scroll-progress");
    const started = performance.now();
    let frame = 0;
    let previous = 0;

    const floats = [...document.querySelectorAll("[data-float]")].map((element) => ({
        element,
        stage: element.querySelector(".stage"),
        shadow: element.querySelector(".float-shadow"),
        hero: element.dataset.float === "hero",
        rx: ENTRY_TILT,
        ry: 0,
        lift: ENTRY_LIFT,
        scale: 0.965,
        opacity: 0,
        rim: 0
    }));

    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

    // How far a stage has scrolled in, 0 to 1. The first screen plays once, on load.
    function entry(item, box, now) {
        if (item.hero) return now - started > 180 ? 1 : 0;
        const height = window.innerHeight;
        return clamp((height * 0.96 - box.top) / (height * 0.46), 0, 1);
    }

    function targets(item, box, now) {
        const shown = entry(item, box, now);
        const height = window.innerHeight;
        const leaving = clamp((-box.top - height * 0.2) / (height * 0.8), 0, 1);
        const next = {
            rx: (1 - shown) * ENTRY_TILT - leaving * ENTRY_TILT * 0.6,
            ry: 0,
            lift: (1 - shown) * ENTRY_LIFT,
            scale: 0.965 + shown * 0.035,
            opacity: Math.min(1, shown * 1.6),
            rim: 0
        };
        if (!pointer.seen || !fine.matches) return next;
        const nearX = Math.max(box.left - pointer.x, 0, pointer.x - box.right);
        const nearY = Math.max(box.top - pointer.y, 0, pointer.y - box.bottom);
        const near = Math.hypot(nearX, nearY);
        next.rim = clamp(1 - near / RIM_REACH, 0, 1);
        // Buttons stay still under the pointer; a resting pointer leaves the text flat and sharp.
        const idle = now - pointer.moved > IDLE_MS;
        if (idle || pointer.onControls || box.bottom < 0 || box.top > height) return next;
        const weight = clamp(1 - near / TILT_REACH, 0, 1);
        const offsetX = clamp((pointer.x - box.left - box.width / 2) / (box.width / 2), -1, 1);
        const offsetY = clamp((pointer.y - box.top - box.height / 2) / (box.height / 2), -1, 1);
        next.rx -= offsetY * MAX_TILT * weight;
        next.ry += offsetX * MAX_TILT * weight;
        next.lift -= HOVER_LIFT * weight;
        return next;
    }

    function paint(item, box) {
        const { stage, shadow } = item;
        const flat =
            Math.abs(item.rx) < 0.02 && Math.abs(item.ry) < 0.02 && Math.abs(item.lift) < 0.1 && item.scale > 0.9995;
        // Dropping the transform when flat puts the video back on the pixel grid.
        stage.style.transform = flat
            ? ""
            : `perspective(1800px) translate3d(0,${item.lift.toFixed(2)}px,0) rotateX(${item.rx.toFixed(3)}deg) rotateY(${item.ry.toFixed(3)}deg) scale(${item.scale.toFixed(4)})`;
        stage.style.opacity = item.opacity.toFixed(3);
        shadow.style.opacity = item.opacity.toFixed(3);
        shadow.style.transform = `translate3d(${(-item.ry * 7).toFixed(1)}px,${(item.rx * 5 + Math.abs(item.lift) * 0.5).toFixed(1)}px,0)`;
        stage.style.setProperty("--rim", item.rim.toFixed(3));
        stage.style.setProperty("--mx", `${(pointer.x - box.left).toFixed(0)}px`);
        stage.style.setProperty("--my", `${(pointer.y - box.top).toFixed(0)}px`);
    }

    function step(now) {
        frame = 0;
        const blend = 1 - Math.exp((-Math.min(34, now - previous) / 1000) * STIFFNESS);
        previous = now;
        let moving = now - pointer.moved <= IDLE_MS + 100 || now - started < 400;
        for (const item of floats) {
            if (document.fullscreenElement === item.stage) continue;
            const box = item.element.getBoundingClientRect();
            const next = targets(item, box, now);
            for (const key of Object.keys(next)) {
                const gap = next[key] - item[key];
                item[key] += gap * blend;
                if (Math.abs(gap) > (key === "scale" ? 0.0002 : 0.004)) moving = true;
                else item[key] = next[key];
            }
            paint(item, box);
        }
        if (moving) schedule();
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(step);
    }

    function showProgress() {
        const range = document.documentElement.scrollHeight - window.innerHeight;
        if (bar) bar.style.transform = `scaleX(${range > 0 ? clamp(window.scrollY / range, 0, 1) : 0})`;
    }

    window.addEventListener(
        "pointermove",
        (event) => {
            if (event.pointerType === "touch") return;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.seen = true;
            pointer.moved = performance.now();
            pointer.onControls = Boolean(event.target.closest?.(".controls"));
            if (grid) {
                const box = hero.getBoundingClientRect();
                grid.style.setProperty("--gx", `${(pointer.x - box.left).toFixed(0)}px`);
                grid.style.setProperty("--gy", `${(pointer.y - box.top).toFixed(0)}px`);
            }
            schedule();
        },
        { passive: true }
    );
    window.addEventListener(
        "scroll",
        () => {
            showProgress();
            schedule();
        },
        { passive: true }
    );
    window.addEventListener("resize", () => {
        showProgress();
        schedule();
    });

    if ("IntersectionObserver" in window) {
        const reveal = new IntersectionObserver(
            (entries) => {
                for (const { isIntersecting, target } of entries) {
                    if (!isIntersecting) continue;
                    target.classList.add("shown");
                    reveal.unobserve(target);
                }
            },
            { threshold: 0.12 }
        );
        document.querySelectorAll("[data-reveal]").forEach((element) => reveal.observe(element));

        const links = new Map([...document.querySelectorAll(".header nav a")].map((a) => [a.hash.slice(1), a]));
        const marker = document.querySelector(".nav-marker");
        const chapters = new IntersectionObserver(
            (entries) => {
                for (const { isIntersecting, target } of entries) {
                    const link = links.get(target.id);
                    if (isIntersecting && link && marker) {
                        marker.style.width = `${link.offsetWidth}px`;
                        marker.style.transform = `translateX(${link.offsetLeft}px)`;
                        marker.style.opacity = "1";
                    } else if (!isIntersecting && target === document.querySelector(".chapter") && marker) {
                        if (target.getBoundingClientRect().top > 0) marker.style.opacity = "0";
                    }
                }
            },
            { rootMargin: "-40% 0px -55% 0px" }
        );
        document.querySelectorAll(".chapter").forEach((section) => chapters.observe(section));
    } else {
        document.querySelectorAll("[data-reveal]").forEach((element) => element.classList.add("shown"));
    }

    showProgress();
    schedule();
})();
