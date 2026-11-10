"use strict";

(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 760px)");

    function setUpClip(figure) {
        const video = figure.querySelector("video");
        const toggle = figure.querySelector("[data-toggle]");
        const enlarge = figure.querySelector("[data-enlarge]");
        const bars = [...figure.querySelectorAll(".progress i")];
        const starts = figure.dataset.steps.split(",").map(Number);
        const duration = Number(figure.dataset.duration);
        let userPaused = reduced.matches;
        let inView = false;
        // In the tools deck only the card in the middle plays; motion.js says which one that is.
        let front = true;
        let frame = 0;

        function showTime() {
            const time = video.currentTime;
            starts.forEach((start, index) => {
                const end = starts[index + 1] ?? duration;
                const filled = Math.min(1, Math.max(0, (time - start) / (end - start)));
                bars[index].style.transform = `scaleX(${filled})`;
            });
        }
        function tick() {
            showTime();
            frame = video.paused ? 0 : requestAnimationFrame(tick);
        }
        function showState() {
            toggle.textContent = video.paused ? toggle.dataset.play : toggle.dataset.pause;
        }
        function sync() {
            if (inView && front && !userPaused) video.play().catch(() => {});
            else video.pause();
        }

        video.addEventListener("play", () => {
            showState();
            if (!frame) frame = requestAnimationFrame(tick);
        });
        video.addEventListener("pause", showState);
        video.addEventListener("seeked", showTime);
        toggle.addEventListener("click", () => {
            userPaused = !video.paused;
            sync();
        });
        figure.addEventListener("deck:front", (event) => {
            front = event.detail;
            sync();
        });
        enlarge.addEventListener("click", () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else if (figure.requestFullscreen) figure.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        });
        figure.addEventListener("fullscreenchange", () => {
            enlarge.textContent = document.fullscreenElement ? enlarge.dataset.exit : enlarge.dataset.enter;
        });

        const hasNarrowPoster = narrow.matches && video.dataset.posterNarrow;
        if (hasNarrowPoster) video.poster = video.dataset.posterNarrow;
        showTime();
        return {
            near() {
                if (!video.poster && video.dataset.poster) video.poster = video.dataset.poster;
            },
            visible(state) {
                inView = state;
                sync();
            }
        };
    }

    const clips = new Map([...document.querySelectorAll("[data-clip]")].map((figure) => [figure, setUpClip(figure)]));
    if ("IntersectionObserver" in window) {
        const near = new IntersectionObserver(
            (entries) => entries.forEach((entry) => entry.isIntersecting && clips.get(entry.target).near()),
            { rootMargin: "1000px 0px" }
        );
        const visible = new IntersectionObserver(
            (entries) => entries.forEach((entry) => clips.get(entry.target).visible(entry.isIntersecting)),
            { threshold: 0.35 }
        );
        for (const figure of clips.keys()) {
            near.observe(figure);
            visible.observe(figure);
        }
    } else {
        for (const clip of clips.values()) clip.near();
    }

    const language = document.querySelector("[data-language]");
    language.addEventListener("click", () => {
        const destination = new URL(language.href);
        destination.hash = window.location.hash;
        language.href = destination.href;
    });
})();
