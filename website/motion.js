"use strict";

// The hero and recordings respond to the pointer with spring physics, and the tools deck follows scrolling.
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
    const FLOAT_MARGIN = `${TILT_REACH + 80}px 0px`;
    const POSE_KEYS = ["rx", "ry", "lift", "scale", "opacity", "rim"];

    const NEUTRAL_POSE = { rx: 0, ry: 0, lift: 0, scale: 1, opacity: 1, rim: 0 };
    const BOTTOM_ENTRY_POSE = { rx: ENTRY_TILT, ry: 0, lift: ENTRY_LIFT, scale: 0.965, opacity: 0, rim: 0 };
    const TOP_EXIT_POSE = { rx: -ENTRY_TILT * 0.6, ry: 0, lift: 0, scale: 1, opacity: 1, rim: 0 };

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const wide = window.matchMedia("(min-width: 901px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const bar = window.CSS?.supports("animation-timeline: scroll(root block)")
        ? null
        : document.querySelector(".scroll-progress");
    const pointer = { x: 0, y: 0, seen: false, moved: -Infinity, onControls: false };
    let frame = 0;
    let previous = null;
    let idleTimer = 0;

    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const smooth = (t) => t * t * (3 - 2 * t);

    // Sample only the hovered surface once per input frame.
    function trackPointer(surface, move, reset) {
        let point;
        let update = 0;
        const leave = () => {
            if (update) cancelAnimationFrame(update);
            update = 0;
            reset();
        };
        surface.addEventListener("pointermove", (event) => {
            if (!fine.matches || !wide.matches || reduced.matches || event.pointerType === "touch") return;
            point = event;
            if (update) return;
            update = requestAnimationFrame(() => {
                update = 0;
                move(point);
            });
        });
        surface.addEventListener("pointerleave", leave);
        surface.addEventListener("pointercancel", leave);
        return leave;
    }

    const hero = document.querySelector("[data-hero]");
    const heroScene = hero?.querySelector("[data-hero-scene]");
    const heroCard = heroScene?.querySelector("[data-hero-card]");
    const gridLight = hero?.querySelector(".hero-grid-light");
    if (heroCard && gridLight) {
        function resetHeroTilt() {
            heroCard.style.removeProperty("--hero-rx");
            heroCard.style.removeProperty("--hero-ry");
        }
        trackPointer(
            hero,
            (point) => {
                const heroBox = hero.getBoundingClientRect();
                const scene = heroScene.contains(point.target) ? heroScene.getBoundingClientRect() : null;
                const x = Math.round((point.clientX - heroBox.left) / 22) * 22;
                const y = Math.round((point.clientY - heroBox.top) / 22) * 22;
                gridLight.style.transform = `translate(${x}px, ${y}px)`;
                if (!gridLight.classList.contains("lit")) gridLight.classList.add("lit");
                if (scene) {
                    const skewX = clamp(((point.clientX - scene.left) / scene.width - 0.5) * 2, -1, 1);
                    const skewY = clamp(((point.clientY - scene.top) / scene.height - 0.5) * 2, -1, 1);
                    heroCard.style.setProperty("--hero-rx", `${(-skewY).toFixed(2)}deg`);
                    heroCard.style.setProperty("--hero-ry", `${(28 + skewX * 2).toFixed(2)}deg`);
                } else {
                    resetHeroTilt();
                }
            },
            () => {
                resetHeroTilt();
                gridLight.classList.remove("lit");
            }
        );
    }

    // The tools deck: scrolling through the track moves every card along one path, from a stack on the right through
    // the middle to a stack on the left. `d` is a card's place on that path, 0 in the middle.
    const track = document.querySelector("[data-deck]");
    const deck = track && {
        track,
        grid: track.querySelector(".tool-grid"),
        cards: [...track.querySelectorAll("[data-card]")],
        dots: [...track.querySelectorAll("[data-dot]")],
        front: -1,
        on: false,
        near: !("IntersectionObserver" in window),
        metrics: null,
        progress: null
    };
    const deckIndices = new Map(deck ? deck.cards.map((card, i) => [card, i]) : []);

    const floats = [...document.querySelectorAll(".clip-frame")].map((element) => ({
        element,
        flight: element.querySelector(".clip-flight"),
        stage: element.querySelector(".stage"),
        shadow: element.querySelector(".float-shadow"),
        rimNode: element.querySelector(".clip-rim"),
        rimGlow: element.querySelector(".clip-rim-glow"),
        deckIndex: deckIndices.get(element.closest("[data-card]")) ?? -1,
        rx: ENTRY_TILT,
        ry: 0,
        lift: ENTRY_LIFT,
        scale: 0.965,
        opacity: 0,
        rim: 0,
        lastStageTransform: "",
        lastShadowTransform: "",
        lastOpacity: null,
        lastRimOpacity: "",
        lastRimPos: "",
        lit: false,
        shown: false
    }));
    const floatByElement = new Map(floats.map((item) => [item.element, item]));
    const nearby = new Set("IntersectionObserver" in window ? [] : floats);

    function setItemPose(item, pose) {
        for (const key of POSE_KEYS) item[key] = pose[key];
    }

    function isNeutral(item) {
        return (
            item.rx === 0 &&
            item.ry === 0 &&
            item.lift === 0 &&
            item.scale === 1 &&
            item.opacity === 1 &&
            item.rim === 0
        );
    }

    function hideRim(item) {
        if (item.lit) {
            item.rimNode?.classList.remove("lit");
            item.lit = false;
        }
        if (item.lastRimOpacity !== "") {
            if (item.rimNode) item.rimNode.style.opacity = "";
            item.lastRimOpacity = "";
        }
    }

    function clearItemStyles(item) {
        if (item.lastStageTransform !== "") {
            item.stage.style.transform = "";
            item.lastStageTransform = "";
        }
        if (item.shadow && item.lastShadowTransform !== "") {
            item.shadow.style.transform = "";
            item.lastShadowTransform = "";
        }
        if (item.flight && item.lastOpacity !== "") {
            item.flight.style.opacity = "";
            item.lastOpacity = "";
        }
        if (!item.shown) {
            item.element.classList.add("clip-shown");
            item.shown = true;
        }
        hideRim(item);
    }

    function targets(item, box, now) {
        const inDeck = item.deckIndex >= 0 && deck?.on;
        const height = window.innerHeight || 0;
        let next;
        if (inDeck) {
            next = { ...NEUTRAL_POSE };
        } else {
            const shown = height > 0 ? clamp((height * 0.96 - box.top) / (height * 0.46), 0, 1) : 1;
            const leaving = height > 0 ? clamp((-box.top - height * 0.2) / (height * 0.8), 0, 1) : 0;
            next = {
                rx: (1 - shown) * ENTRY_TILT - leaving * ENTRY_TILT * 0.6,
                ry: 0,
                lift: (1 - shown) * ENTRY_LIFT,
                scale: 0.965 + shown * 0.035,
                opacity: Math.min(1, shown * 1.6),
                rim: 0
            };
        }
        let hoverActive = false;
        if (
            pointer.seen &&
            fine.matches &&
            wide.matches &&
            !reduced.matches &&
            (!inDeck || item.deckIndex === deck.front) &&
            box.width > 0 &&
            box.height > 0
        ) {
            const nearX = Math.max(box.left - pointer.x, 0, pointer.x - box.right);
            const nearY = Math.max(box.top - pointer.y, 0, pointer.y - box.bottom);
            const near = Math.hypot(nearX, nearY);
            next.rim = clamp(1 - near / RIM_REACH, 0, 1);
            // Buttons stay still under the pointer; a resting pointer leaves the video flat and sharp.
            const idle = now - pointer.moved > IDLE_MS;
            if (!idle && !pointer.onControls && box.bottom >= 0 && box.top <= height) {
                const weight = clamp(1 - near / TILT_REACH, 0, 1);
                if (weight > 0) {
                    const offsetX = clamp((pointer.x - box.left - box.width / 2) / (box.width / 2), -1, 1);
                    const offsetY = clamp((pointer.y - box.top - box.height / 2) / (box.height / 2), -1, 1);
                    next.rx -= offsetY * MAX_TILT * weight;
                    next.ry += offsetX * MAX_TILT * weight;
                    next.lift -= HOVER_LIFT * weight;
                    hoverActive = true;
                }
            }
        }
        return { next, hoverActive };
    }

    function paint(item, box) {
        const flat =
            Math.abs(item.rx) < 0.02 && Math.abs(item.ry) < 0.02 && Math.abs(item.lift) < 0.1 && item.scale > 0.9995;
        // Dropping the transform when flat puts the video back on the pixel grid.
        const stageTransform = flat
            ? ""
            : `perspective(1800px) translate3d(0,${item.lift.toFixed(2)}px,0) rotateX(${item.rx.toFixed(3)}deg) rotateY(${item.ry.toFixed(3)}deg) scale(${item.scale.toFixed(4)})`;
        if (stageTransform !== item.lastStageTransform) {
            item.stage.style.transform = stageTransform;
            item.lastStageTransform = stageTransform;
        }

        const isShown = item.opacity >= 0.999;
        if (isShown !== item.shown) {
            item.element.classList.toggle("clip-shown", isShown);
            item.shown = isShown;
        }
        if (item.flight) {
            const opacity = isShown ? "" : item.opacity.toFixed(3);
            if (opacity !== item.lastOpacity) {
                item.flight.style.opacity = opacity;
                item.lastOpacity = opacity;
            }
        }

        if (item.shadow) {
            const sx = -item.ry * 7;
            const sy = item.rx * 5 + Math.abs(item.lift) * 0.5;
            const shadowTransform =
                Math.abs(sx) < 0.08 && Math.abs(sy) < 0.08
                    ? ""
                    : `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`;
            if (shadowTransform !== item.lastShadowTransform) {
                item.shadow.style.transform = shadowTransform;
                item.lastShadowTransform = shadowTransform;
            }
        }

        if (item.rimNode) {
            if (item.rim <= 0.001) {
                hideRim(item);
            } else {
                if (!item.lit) {
                    item.rimNode.classList.add("lit");
                    item.lit = true;
                }
                const rimOpacity = item.rim.toFixed(3);
                if (rimOpacity !== item.lastRimOpacity) {
                    item.rimNode.style.opacity = rimOpacity;
                    item.lastRimOpacity = rimOpacity;
                }
                if (item.rimGlow && pointer.seen) {
                    const pos = `translate3d(${Math.round(pointer.x - box.left)}px,${Math.round(pointer.y - box.top)}px,0)`;
                    if (pos !== item.lastRimPos) {
                        item.rimGlow.style.transform = pos;
                        item.lastRimPos = pos;
                    }
                }
            }
        }
    }

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
        const perspective = parseFloat(getComputedStyle(deck.grid).perspective) || 1800;
        const half = deck.grid.clientWidth / 2 - SIDE_MARGIN;
        const edgeZ = -SIDE_DEPTH + (width / 2) * Math.sin((SIDE_ANGLE * Math.PI) / 180);
        const reach = (half * (perspective - edgeZ)) / perspective - (width / 2) * SIDE_COS;
        const deepest = Math.max(0, deck.cards.length - 2 + DECK_MARGIN);
        return clamp((reach / width - SIDE_BASE) / (SIDE_FIRST + sideGaps(deepest)), 0.2, 1);
    }

    function updateDeckMode() {
        if (!deck || wide.matches === deck.on) return;
        deck.on = wide.matches;
        deck.track.classList.toggle("deck-on", deck.on);
        if (deck.on) {
            for (const item of floats) {
                if (item.deckIndex < 0) continue;
                setItemPose(item, NEUTRAL_POSE);
                clearItemStyles(item);
            }
            notifyFront(0);
        } else {
            for (const item of deck.cards) {
                item.style.transform = "";
                item.style.zIndex = "";
                item.style.removeProperty("--front");
            }
            notifyFront(-2);
        }
    }

    function readDeckTop() {
        if (!deck?.on || !deck.near || !deck.cards.length) return null;
        if (!deck.metrics) {
            const width = deck.cards[0].offsetWidth;
            deck.metrics = {
                width,
                fit: deckFit(width),
                range: Math.max(1, deck.track.offsetHeight - window.innerHeight)
            };
        }
        return deck.track.getBoundingClientRect().top;
    }

    function applyDeck(top) {
        const { width, fit, range } = deck.metrics;
        const progress = -DECK_MARGIN + clamp(-top / range, 0, 1) * (deck.cards.length - 1 + 2 * DECK_MARGIN);
        if (progress === deck.progress) return false;
        deck.progress = progress;
        deck.cards.forEach((item, index) => {
            const d = progress - index;
            const pose = cardPose(d, width, fit);
            item.style.transform = `translate3d(${pose.x.toFixed(1)}px,0,${pose.z.toFixed(1)}px) rotateY(${pose.ry.toFixed(2)}deg)`;
            item.style.zIndex = String(100 - Math.round(Math.abs(d) * 10));
            item.style.setProperty("--front", pose.front.toFixed(3));
        });
        const front = clamp(Math.round(progress), 0, deck.cards.length - 1);
        if (front === deck.front) return false;
        notifyFront(front);
        return true;
    }

    // Plays the middle card's recording and pauses the rest; -2 hands every clip back to its own visibility.
    function notifyFront(front) {
        deck.front = front;
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

    function step(timestamp) {
        frame = 0;
        if (document.hidden) {
            previous = null;
            return;
        }
        const now = typeof timestamp === "number" ? timestamp : performance.now();
        const dt = previous === null ? 16 : Math.min(34, Math.max(0, now - previous));
        const blend = 1 - Math.exp((-dt / 1000) * STIFFNESS);
        previous = now;

        // Phase 1 (READ ONLY): measure geometry before mutating styles.
        const range = bar ? document.documentElement.scrollHeight - window.innerHeight : 0;
        const deckTop = readDeckTop();
        const activeItems = [];
        if (!reduced.matches) {
            for (const item of nearby) {
                if (document.fullscreenElement === item.stage) continue;
                const inDeck = item.deckIndex >= 0 && deck?.on;
                if (inDeck && item.deckIndex !== deck.front && isNeutral(item)) continue;
                activeItems.push({ item, box: item.element.getBoundingClientRect() });
            }
        }

        // Phase 2 (WRITE ONLY): apply deck layout, progress bar, and floating physics.
        const deckFrontChanged = deckTop !== null ? applyDeck(deckTop) : false;
        if (bar) bar.style.transform = `scaleX(${range > 0 ? clamp(window.scrollY / range, 0, 1) : 0})`;

        let moving = false;
        let needIdleWake = false;
        for (const { item, box } of activeItems) {
            const { next, hoverActive } = targets(item, box, now);
            if (hoverActive) needIdleWake = true;
            for (const key of POSE_KEYS) {
                const gap = next[key] - item[key];
                item[key] += gap * blend;
                if (Math.abs(gap) > (key === "scale" ? 0.0002 : 0.004)) moving = true;
                else item[key] = next[key];
            }
            paint(item, box);
        }

        if (moving || deckFrontChanged) {
            schedule();
        } else {
            previous = null;
            if (needIdleWake && !idleTimer) {
                const wait = Math.max(16, IDLE_MS - (now - pointer.moved) + 16);
                idleTimer = setTimeout(() => {
                    idleTimer = 0;
                    schedule();
                }, wait);
            }
        }
    }

    function schedule() {
        if (frame || document.hidden) return;
        if (!bar && !(deck?.on && deck.near) && (reduced.matches || nearby.size === 0)) return;
        frame = requestAnimationFrame(step);
    }

    window.addEventListener(
        "pointermove",
        (event) => {
            if (!fine.matches || !wide.matches || reduced.matches || event.pointerType === "touch") return;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.seen = true;
            pointer.moved = performance.now();
            pointer.onControls = Boolean(event.target?.closest?.(".controls"));
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = 0;
            }
            if (nearby.size > 0) schedule();
        },
        { passive: true }
    );
    const clearPointer = () => {
        pointer.seen = false;
        pointer.onControls = false;
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = 0;
        }
        if (nearby.size > 0) schedule();
    };
    document.documentElement.addEventListener("pointerleave", clearPointer);
    window.addEventListener("blur", clearPointer);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", () => {
        updateDeckMode();
        if (deck) {
            deck.metrics = null;
            deck.progress = null;
        }
        schedule();
    });
    document.addEventListener("fullscreenchange", () => {
        for (const item of floats) {
            if (document.fullscreenElement === item.stage) {
                setItemPose(item, NEUTRAL_POSE);
                clearItemStyles(item);
            }
        }
        schedule();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = 0;
            }
            previous = null;
        } else {
            schedule();
        }
    });
    reduced.addEventListener?.("change", () => {
        if (reduced.matches) {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = 0;
            }
            previous = null;
            for (const item of floats) {
                setItemPose(item, NEUTRAL_POSE);
                clearItemStyles(item);
            }
        } else {
            schedule();
        }
    });

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
        updateDeckMode();
        if ("IntersectionObserver" in window) {
            const deckNearby = new IntersectionObserver(
                ([entry]) => {
                    deck.near = entry.isIntersecting;
                    if (deck.near) schedule();
                },
                { rootMargin: "200px 0px" }
            );
            deckNearby.observe(track);
        }
    }

    if ("IntersectionObserver" in window) {
        const floatObserver = new IntersectionObserver(
            (entries) => {
                let woke = false;
                for (const entry of entries) {
                    const item = floatByElement.get(entry.target);
                    if (!item) continue;
                    if (entry.isIntersecting) {
                        if (!nearby.has(item)) {
                            nearby.add(item);
                            if (item.deckIndex >= 0 && deck?.on) {
                                setItemPose(item, NEUTRAL_POSE);
                                clearItemStyles(item);
                            } else if (entry.boundingClientRect?.bottom < 0) {
                                setItemPose(item, TOP_EXIT_POSE);
                            } else if (
                                entry.boundingClientRect &&
                                entry.boundingClientRect.top > (window.innerHeight || 0)
                            ) {
                                setItemPose(item, BOTTOM_ENTRY_POSE);
                            }
                            woke = true;
                        }
                    } else {
                        nearby.delete(item);
                        item.rim = 0;
                        hideRim(item);
                    }
                }
                if (woke) schedule();
            },
            { rootMargin: FLOAT_MARGIN }
        );
        for (const item of floats) floatObserver.observe(item.element);

        const ambientVisible = new Set();
        function syncAmbient() {
            const playing = !document.hidden && !document.fullscreenElement;
            for (const target of ambientVisible) target.classList.toggle("ambient-playing", playing);
        }

        const reveal = new IntersectionObserver(
            (entries) => {
                for (const { isIntersecting, intersectionRatio, target } of entries) {
                    const ambient = target.hasAttribute("data-ambient");
                    if (ambient) {
                        if (isIntersecting && intersectionRatio >= 0.12) ambientVisible.add(target);
                        else {
                            ambientVisible.delete(target);
                            target.classList.remove("ambient-playing");
                        }
                    }
                    if (isIntersecting && !target.classList.contains("shown")) target.classList.add("shown");
                    if (isIntersecting && !ambient) reveal.unobserve(target);
                }
                syncAmbient();
            },
            { threshold: 0.12 }
        );
        document.querySelectorAll("[data-reveal]").forEach((element) => reveal.observe(element));
        document.addEventListener("visibilitychange", syncAmbient);
        document.addEventListener("fullscreenchange", syncAmbient);

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

    schedule();
})();
