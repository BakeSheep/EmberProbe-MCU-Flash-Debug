"use strict";

// Page motion: recordings tilt toward the pointer and settle as they scroll in, and the tools deck moves with
// scrolling. All of it is decoration: without JavaScript, or with reduced
// motion, the page renders complete (see the "motion" class in <head>).
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
    const DECK_MARGIN = 0.4; // card positions before the first card's middle and after the last one's

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const wide = window.matchMedia("(min-width: 901px)");
    const pointer = { x: 0, y: 0, seen: false, moved: -Infinity, onControls: false };
    const grid = document.querySelector(".hero-grid");
    const heroSection = document.querySelector("[data-hero]");
    const bar = document.querySelector(".scroll-progress");
    const started = performance.now();
    let frame = 0;
    let previous = 0;

    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const smooth = (t) => t * t * (3 - 2 * t);

    const floats = [...document.querySelectorAll("[data-float]")].map((element) => ({
        element,
        stage: element.querySelector(".stage"),
        shadow: element.querySelector(".float-shadow"),
        rx: ENTRY_TILT,
        ry: 0,
        lift: ENTRY_LIFT,
        scale: 0.965,
        opacity: 0,
        rim: 0
    }));

    // Keep the hero at its native layout size; only its viewing angle changes, without a persistent bitmap hint.
    const heroScene = document.querySelector("[data-hero-scene]");
    const heroCard = heroScene?.querySelector("[data-hero-card]");
    if (heroCard) {
        heroScene.addEventListener("pointermove", (event) => {
            if (!fine.matches || !wide.matches) return;
            const box = heroScene.getBoundingClientRect();
            const x = clamp(((event.clientX - box.left) / box.width - 0.5) * 2, -1, 1);
            const y = clamp(((event.clientY - box.top) / box.height - 0.5) * 2, -1, 1);
            heroCard.style.setProperty("--hero-rx", `${(-y).toFixed(2)}deg`);
            heroCard.style.setProperty("--hero-ry", `${(28 + x * 2).toFixed(2)}deg`);
        });
        heroScene.addEventListener("pointerleave", () => {
            heroCard.style.removeProperty("--hero-rx");
            heroCard.style.removeProperty("--hero-ry");
        });
    }

    // How far a stage has scrolled in, 0 to 1.
    function entry(box) {
        const height = window.innerHeight;
        return clamp((height * 0.96 - box.top) / (height * 0.46), 0, 1);
    }

    function targets(item, box, now) {
        const shown = entry(box);
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

    // The tools deck: scrolling through the track moves every card along one path, from a stack on the right through
    // the middle to a stack on the left. `d` is a card's place on that path, 0 in the middle.
    const track = document.querySelector("[data-deck]");
    const deck = track && {
        track,
        cards: [...track.querySelectorAll("[data-card]")],
        dots: [...track.querySelectorAll("[data-dot]")],
        front: -1,
        on: false
    };

    // A cover-flow path. d < 0: waiting on the right; d > 0: passed, on the left. Stacked cards share one angle and
    // depth, their outer edge toward the reader and their inner edge turned away. Each stacked card shows as a strip
    // beside the one on top of it: the stack keeps a clear gap from the middle card, and the strips narrow toward the
    // bottom of the pile at the screen edge. `fit` (at most 1) narrows the gap and strips so the pile stays on screen.
    const SIDE_ANGLE = 58; // degrees
    const SIDE_DEPTH = 260; // pixels
    const SIDE_FIRST = 0.2; // card widths of the first stacked card showing beside the middle one
    const SIDE_GAP = 0.12; // card widths: the strips are 0.10, 0.06, 0.02 … wide, narrowing outward
    const SIDE_GAP_SHRINK = 0.02;
    const SIDE_MARGIN = 32; // pixels kept clear between the outermost card and the edge of the screen
    const SIDE_COS = Math.cos((SIDE_ANGLE * Math.PI) / 180);
    // From the middle to where the first stacked card's turned outer edge just meets the middle card's edge.
    const SIDE_BASE = 0.5 * (1 - SIDE_COS);
    const sideGaps = (deeper) => deeper * SIDE_GAP - deeper * deeper * SIDE_GAP_SHRINK;

    function cardPose(d, width, fit) {
        const side = -Math.sign(d);
        const distance = Math.abs(d);
        const step = smooth(clamp(distance, 0, 1));
        const deeper = Math.max(0, distance - 1);
        return {
            x: side * width * (step * (SIDE_BASE + fit * SIDE_FIRST) + fit * sideGaps(deeper)),
            z: -step * SIDE_DEPTH,
            ry: -side * step * SIDE_ANGLE,
            front: 1 - step
        };
    }

    // The largest share of the gap and strips that keeps the outermost card's outer edge, which is turned toward the
    // reader and so drawn larger, inside the deck.
    function deckFit(width) {
        const grid = deck.track.querySelector(".tool-grid");
        const perspective = parseFloat(getComputedStyle(grid).perspective) || 1800;
        const half = grid.getBoundingClientRect().width / 2 - SIDE_MARGIN;
        const edgeZ = -SIDE_DEPTH + (width / 2) * Math.sin((SIDE_ANGLE * Math.PI) / 180);
        const reach = (half * (perspective - edgeZ)) / perspective - (width / 2) * SIDE_COS;
        const deepest = Math.max(0, deck.cards.length - 2 + DECK_MARGIN);
        return clamp((reach / width - SIDE_BASE) / (SIDE_FIRST + sideGaps(deepest)), 0.2, 1);
    }

    // Scroll range of the track as card positions: the first card is on its way in from the right at the top, the
    // last is on its way out to the left at the bottom.
    function deckProgress() {
        const box = deck.track.getBoundingClientRect();
        const range = Math.max(1, box.height - window.innerHeight);
        const count = deck.cards.length;
        return -DECK_MARGIN + clamp(-box.top / range, 0, 1) * (count - 1 + 2 * DECK_MARGIN);
    }

    function layoutDeck() {
        const on = wide.matches;
        if (on !== deck.on) {
            deck.on = on;
            deck.track.classList.toggle("deck-on", on);
            if (!on) {
                for (const item of deck.cards) {
                    item.style.transform = "";
                    item.style.zIndex = "";
                    item.style.removeProperty("--front");
                }
                deck.front = -1;
                notifyFront(-2);
                return;
            }
        }
        if (!on) return;
        const progress = deckProgress();
        const width = deck.cards[0].offsetWidth;
        const fit = deckFit(width);
        deck.cards.forEach((item, index) => {
            const d = progress - index;
            const pose = cardPose(d, width, fit);
            item.style.transform = `translate3d(${pose.x.toFixed(1)}px,0,${pose.z.toFixed(1)}px) rotateY(${pose.ry.toFixed(2)}deg)`;
            item.style.zIndex = String(100 - Math.round(Math.abs(d) * 10));
            item.style.setProperty("--front", pose.front.toFixed(3));
        });
        const front = clamp(Math.round(progress), 0, deck.cards.length - 1);
        if (front !== deck.front) {
            deck.front = front;
            notifyFront(front);
        }
    }

    // Plays the middle card's recording and pauses the rest; -2 hands every clip back to its own visibility.
    function notifyFront(front) {
        deck.cards.forEach((item, index) => {
            item.querySelector("[data-clip]")?.dispatchEvent(
                new CustomEvent("deck:front", { detail: front === -2 || index === front })
            );
        });
        deck.dots.forEach((dot, index) => {
            if (index === front) dot.setAttribute("aria-current", "true");
            else dot.removeAttribute("aria-current");
        });
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
                const box = heroSection.getBoundingClientRect();
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
            if (deck) layoutDeck();
            schedule();
        },
        { passive: true }
    );
    window.addEventListener("resize", () => {
        showProgress();
        if (deck) layoutDeck();
        schedule();
    });
    document.addEventListener("visibilitychange", schedule);

    if (deck) {
        // A dot scrolls to the point where its card sits in the middle.
        deck.dots.forEach((dot, index) =>
            dot.addEventListener("click", () => {
                const box = deck.track.getBoundingClientRect();
                const range = box.height - window.innerHeight;
                const share = (index + DECK_MARGIN) / (deck.cards.length - 1 + 2 * DECK_MARGIN);
                window.scrollTo({ top: window.scrollY + box.top + range * share, behavior: "smooth" });
            })
        );
        layoutDeck();
    }

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
