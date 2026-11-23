"use strict";

(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 760px)");
    const canObserve = "IntersectionObserver" in window;
    const MIN_VISIBLE = 0.35;
    const AUTOPLAY_DELAY_MS = 200;
    let active = null;
    let manual = null;
    let pending = null;
    let autoplayTimer = 0;
    let lastScroll = -Infinity;

    function setUpClip(figure) {
        const screen = figure.querySelector(".screen");
        const video = figure.querySelector("video");
        const poster = figure.querySelector(".clip-poster");
        const toggle = figure.querySelector("[data-toggle]");
        const enlarge = figure.querySelector("[data-enlarge]");
        const bars = [...figure.querySelectorAll(".progress i")];
        const starts = figure.dataset.steps.split(",").map(Number);
        const duration = Number(figure.dataset.duration);
        const progress = bars.map(() => 0);
        const media = (element, key) => (narrow.matches && element.dataset[key + "Narrow"]) || element.dataset[key];
        let firstFrame = null;

        function showFrame() {
            firstFrame = null;
            screen.classList.add("frame-ready");
        }

        const clip = {
            video,
            poster,
            visible: !canObserve,
            ratio: 0,
            front: true,
            userPaused: false,
            loadPoster() {
                const source = media(poster, "poster");
                if (poster.getAttribute("src") !== source) poster.src = source;
            },
            play() {
                clip.loadPoster();
                const source = media(video, "src");
                if (video.getAttribute("src") !== source) {
                    screen.classList.remove("frame-ready");
                    if (firstFrame !== null) video.cancelVideoFrameCallback(firstFrame);
                    video.src = source;
                    if (video.requestVideoFrameCallback) firstFrame = video.requestVideoFrameCallback(showFrame);
                }
                if (video.paused) video.play().catch(() => {});
            }
        };

        function showTime() {
            const time = video.currentTime;
            starts.forEach((start, index) => {
                const end = starts[index + 1] ?? duration;
                const filled = Math.min(1, Math.max(0, (time - start) / (end - start)));
                if (filled === progress[index]) return;
                progress[index] = filled;
                bars[index].style.transform = `scaleX(${filled})`;
            });
        }
        function showState() {
            toggle.textContent = video.paused ? toggle.dataset.play : toggle.dataset.pause;
        }

        // Keep the cover above the video until a decoded frame reaches the compositor.
        if (!video.requestVideoFrameCallback) video.addEventListener("playing", showFrame);
        video.addEventListener("timeupdate", showTime);
        video.addEventListener("play", showState);
        video.addEventListener("pause", showState);
        toggle.addEventListener("click", () => {
            clip.userPaused = !video.paused;
            manual = clip.userPaused ? null : clip;
            updatePlayback(!clip.userPaused);
        });
        figure.addEventListener("deck:front", (event) => {
            clip.front = event.detail;
            updatePlayback();
        });
        enlarge.addEventListener("click", () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else if (figure.requestFullscreen) figure.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        });
        figure.addEventListener("fullscreenchange", () => {
            enlarge.textContent = document.fullscreenElement ? enlarge.dataset.exit : enlarge.dataset.enter;
            updatePlayback();
        });
        return clip;
    }

    // Observe the stationary wrapper so tilting the stage doesn't change its playback visibility.
    const clips = new Map(
        [...document.querySelectorAll(".clip-frame")].map((frame) => [
            frame,
            setUpClip(frame.querySelector("[data-clip]"))
        ])
    );

    function wantedClip() {
        if (document.hidden) return null;
        const fullscreen = clips.get(document.fullscreenElement?.closest(".clip-frame"));
        if (fullscreen) {
            return !fullscreen.userPaused && (fullscreen === manual || !reduced.matches) ? fullscreen : null;
        }
        if (manual?.visible && manual.front) return manual;
        if (reduced.matches) return null;
        let best = null;
        for (const clip of clips.values()) {
            if (!clip.front || clip.userPaused || clip.ratio < MIN_VISIBLE) continue;
            if (!best || clip.ratio > best.ratio || (clip.ratio === best.ratio && clip === active)) best = clip;
        }
        return best;
    }

    function startWhenSettled() {
        const remaining = AUTOPLAY_DELAY_MS - (performance.now() - lastScroll);
        if (remaining > 0) {
            autoplayTimer = setTimeout(startWhenSettled, remaining);
            return;
        }
        pending = null;
        updatePlayback(true);
    }

    // Keep new downloads and decoders off the scroll path. Play buttons can start immediately.
    function updatePlayback(immediate = false) {
        const next = wantedClip();
        if (pending && (pending !== next || immediate)) {
            clearTimeout(autoplayTimer);
            pending = null;
        }
        if (active && active !== next) {
            active.video.pause();
            active = null;
        }
        if (!next) return;
        if (immediate) {
            active = next;
            active.play();
        } else if (!active && !pending) {
            pending = next;
            autoplayTimer = setTimeout(startWhenSettled, AUTOPLAY_DELAY_MS);
        }
    }

    if (canObserve) {
        const near = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    clips.get(entry.target).loadPoster();
                    near.unobserve(entry.target);
                }
            },
            { rootMargin: "600px 0px" }
        );
        const visible = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const clip = clips.get(entry.target);
                    clip.visible = entry.isIntersecting;
                    clip.ratio = entry.intersectionRatio;
                    if (
                        manual === clip &&
                        !clip.visible &&
                        document.fullscreenElement?.closest(".clip-frame") !== entry.target
                    ) {
                        manual = null;
                    }
                }
                updatePlayback();
            },
            { threshold: [0, MIN_VISIBLE, 0.65, 1] }
        );
        for (const frame of clips.keys()) {
            near.observe(frame);
            visible.observe(frame);
        }
    } else {
        for (const clip of clips.values()) clip.loadPoster();
    }
    window.addEventListener(
        "scroll",
        () => {
            lastScroll = performance.now();
        },
        { passive: true }
    );
    document.addEventListener("visibilitychange", () => updatePlayback());
    reduced.addEventListener("change", () => updatePlayback());
    narrow.addEventListener("change", () => {
        for (const clip of clips.values()) {
            if (clip.poster.hasAttribute("src")) clip.loadPoster();
        }
        active?.play();
    });

    const language = document.querySelector("[data-language]");
    language.addEventListener("click", () => {
        const destination = new URL(language.href);
        destination.hash = window.location.hash;
        language.href = destination.href;
    });
})();
