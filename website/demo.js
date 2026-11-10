"use strict";

// The guided tour around the mockup. The frames are same-origin, so the tour reads real element positions and
// listens to real input. A step only completes on what the visitor does, or on what the mockup then shows.
(() => {
    const language = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh";
    const c = JSON.parse(document.getElementById("demo-translations").textContent)[language];
    const { chapters } = window.EmberProbeTour;
    const element = (id) => document.getElementById(id);
    const source = (chapter) => `editor/?lang=${language}&theme=light${chapter?.query ?? ""}`;
    const narrow = window.matchMedia?.("(max-width: 900px)");
    const POLL = 150;
    const READY_DELAY = 900;
    const SPOT_PADDING = 4;

    const state = {
        chapter: 0,
        step: 0,
        done: new Set(),
        finished: false,
        active: false,
        preparing: false,
        settling: false
    };
    // Bumped whenever a chapter starts or the tour stops, so a slower setup never touches a newer frame.
    let run = 0;
    let spotted = null;
    const listened = new WeakSet();

    document.documentElement.lang = c.htmlLang;
    document.title = c.demoTitle;
    document.body.dataset.lang = language;
    for (const [id, key] of Object.entries({
        "back-label": "back",
        "simulation-label": "simulation",
        "reset-demo": "reset",
        "tour-heading": "tourTitle",
        "tour-exit": "tourExit",
        "tour-resume": "tourResume",
        "tour-preparing": "tourPreparing",
        "mobile-hint": "mobileHint",
        "mobile-link": "mobileLink",
        "demo-language": "language"
    }))
        element(id).textContent = c[key];
    element("demo-back").href = language === "en" ? "../en/" : "../";
    element("mobile-link").href = language === "en" ? "../en/" : "../";
    element("demo-language").href = `?lang=${language === "en" ? "zh" : "en"}`;
    element("demo-editor").title = c.demoTitle;

    const frame = () => element("demo-editor");
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    const env = {
        sleep,
        get shell() {
            return frame().contentDocument;
        },
        get sidebar() {
            return env.shell?.getElementById("sidebarFrame")?.contentDocument;
        },
        get chart() {
            return env.shell?.getElementById("livewatchFrame")?.contentDocument;
        },
        async until(condition, timeout = 10000) {
            const limit = Date.now() + timeout;
            while (Date.now() < limit) {
                if (condition(env)) return true;
                await sleep(POLL);
            }
            return false;
        }
    };

    const replaceFrame = (src) => {
        // Replacing the frame discards all hosts, samples, pending debug starts and edited values.
        // Do not clear localStorage: other mockup tabs may be using the stored theme or background.
        const current = frame();
        const fresh = current.cloneNode(false);
        fresh.src = src;
        current.replaceWith(fresh);
    };

    function targetOf(step) {
        const doc = env[step.frame ?? "sidebar"];
        if (!doc) return null;
        return (typeof step.target === "function" ? step.target(doc) : doc.querySelector(step.target)) ?? null;
    }

    function currentStep() {
        if (!state.active || state.preparing || state.settling) return null;
        return chapters[state.chapter].steps[state.step] ?? null;
    }

    async function completeStep(step) {
        const token = run;
        spotted = null;
        state.step += 1;
        const last = state.step >= chapters[state.chapter].steps.length;
        if (last) {
            state.done.add(state.chapter);
            state.finished = state.done.size === chapters.length;
        }
        draw();
        if (step.after) {
            state.settling = true;
            await step.after(env);
            if (token === run) state.settling = false;
        }
    }

    function handleInput(event) {
        const step = currentStep();
        if (!step || typeof step.done !== "string") return;
        const wanted = { click: ["click"], input: ["input", "change"], enter: ["keydown"], hover: ["mouseover"] };
        if (!wanted[step.done]?.includes(event.type)) return;
        if (step.done === "enter" && event.key !== "Enter") return;
        const target = targetOf(step);
        if (!target || event.target.ownerDocument !== target.ownerDocument || !target.contains(event.target)) return;
        // After the page's own handlers: a click may replace the very element the step was highlighting.
        setTimeout(() => {
            if (currentStep() === step) completeStep(step);
        });
    }

    function listen() {
        for (const doc of [env.shell, env.sidebar, env.chart]) {
            if (!doc || listened.has(doc)) continue;
            listened.add(doc);
            for (const type of ["click", "input", "change", "keydown", "mouseover"])
                doc.addEventListener(type, handleInput, true);
        }
    }

    // The target's box in the coordinates of the editor stage, clipped to the frames around it.
    function boxOf(target, step) {
        const box = target.getBoundingClientRect();
        let left = box.left;
        let top = box.top;
        let right = box.right;
        let bottom = box.bottom;
        const clip = (rect) => {
            left = Math.max(left + rect.left, rect.left);
            top = Math.max(top + rect.top, rect.top);
            right = Math.min(right + rect.left, rect.right);
            bottom = Math.min(bottom + rect.top, rect.bottom);
        };
        if (step.frame !== "shell") {
            const id = step.frame === "chart" ? "livewatchFrame" : "sidebarFrame";
            clip(env.shell.getElementById(id).getBoundingClientRect());
        }
        const stage = element("editor-stage").getBoundingClientRect();
        const outer = frame().getBoundingClientRect();
        clip({ left: outer.left - stage.left, top: outer.top - stage.top, right: stage.width, bottom: stage.height });
        return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
    }

    function placeSpot() {
        const spot = element("tour-spot");
        const step = currentStep();
        const target = step && targetOf(step);
        // A disabled control ignores input, so it is not offered until it can be used.
        const box = target?.isConnected && !target.disabled ? boxOf(target, step) : null;
        spot.hidden = !box;
        if (box) {
            const width = box.right - box.left + SPOT_PADDING * 2;
            const height = box.bottom - box.top + SPOT_PADDING * 2;
            spot.style.width = `${width}px`;
            spot.style.height = `${height}px`;
            spot.style.transform = `translate(${box.left - SPOT_PADDING}px, ${box.top - SPOT_PADDING}px)`;
        }
        if (state.active) requestAnimationFrame(placeSpot);
    }

    function poll() {
        const step = currentStep();
        if (!step) return;
        listen();
        const target = targetOf(step);
        if (target && spotted !== step) {
            spotted = step;
            target.scrollIntoView({ block: "center", inline: "nearest" });
        }
        if (typeof step.done === "function" && step.done(env)) completeStep(step);
    }

    function stepRow(step, index) {
        const [title, detail] = step[language];
        const status = index < state.step ? "done" : index === state.step ? "current" : "";
        const row = document.createElement("li");
        row.className = `tour-step ${status}`;
        row.append(Object.assign(document.createElement("strong"), { textContent: title }));
        if (index === state.step) row.append(Object.assign(document.createElement("span"), { textContent: detail }));
        return row;
    }

    function actionRow() {
        const chapter = chapters[state.chapter];
        const row = document.createElement("div");
        row.className = "tour-actions";
        const button = (text, primary, action) => {
            const control = Object.assign(document.createElement("button"), { type: "button", textContent: text });
            control.className = primary ? "tour-button primary" : "tour-button";
            control.addEventListener("click", action);
            row.append(control);
        };
        if (state.step >= chapter.steps.length) {
            const next = chapters.findIndex((_, index) => index > state.chapter && !state.done.has(index));
            const message = next < 0 && state.finished ? c.tourAllDone : c.tourChapterDone;
            row.append(Object.assign(document.createElement("p"), { textContent: message }));
            if (next >= 0) button(c.tourNextChapter, true, () => startChapter(next));
            else if (state.finished) button(c.tourExit, true, stopTour);
            else button(c.tourNextChapter, true, () => startChapter(state.chapter + 1));
            return row;
        }
        const step = chapter.steps[state.step];
        if (step.done === "read") button(c.tourNext, true, () => completeStep(step));
        else button(c.tourSkip, false, () => completeStep(step));
        return row;
    }

    function draw() {
        const list = element("tour-chapters");
        list.replaceChildren();
        chapters.forEach((chapter, index) => {
            const item = document.createElement("li");
            const current = index === state.chapter;
            item.className = `tour-chapter${current ? " current" : ""}${state.done.has(index) ? " done" : ""}`;
            const open = document.createElement("button");
            open.type = "button";
            open.append(
                Object.assign(document.createElement("span"), {
                    className: "number",
                    textContent: state.done.has(index) ? "✓" : String(index + 1)
                }),
                Object.assign(document.createElement("span"), { textContent: chapter.title[language] })
            );
            if (current) open.setAttribute("aria-current", "step");
            open.addEventListener("click", () => startChapter(index));
            item.append(open);
            if (current) {
                const steps = document.createElement("ol");
                steps.className = "tour-steps";
                steps.append(...chapter.steps.map(stepRow));
                item.append(steps);
                if (!state.preparing) item.append(actionRow());
            }
            list.append(item);
        });
        document.body.classList.toggle("tour-on", state.active);
        document.body.classList.toggle("tour-preparing", state.active && state.preparing);
    }

    async function ready(token) {
        await env.until(() => env.sidebar?.getElementById("liveToggle") && env.chart?.getElementById("run"));
        // The hosts answer the pages' first messages after their load events.
        await sleep(READY_DELAY);
        return token === run;
    }

    async function startChapter(index, { reuseFrame = false } = {}) {
        const token = ++run;
        const chapter = chapters[index];
        Object.assign(state, { chapter: index, step: 0, active: true, preparing: true, settling: false });
        spotted = null;
        draw();
        requestAnimationFrame(placeSpot);
        if (!reuseFrame) replaceFrame(source(chapter));
        if (!(await ready(token))) return;
        await chapter.setup?.(env);
        await sleep(POLL);
        if (token !== run) return;
        state.preparing = false;
        draw();
    }

    function stopTour() {
        run += 1;
        Object.assign(state, { active: false, preparing: false, settling: false });
        draw();
    }

    element("tour-exit").addEventListener("click", stopTour);
    element("tour-resume").addEventListener("click", () => startChapter(state.chapter));
    element("reset-demo").addEventListener("click", () => {
        state.done.clear();
        state.finished = false;
        if (narrow?.matches) {
            replaceFrame(source());
            return;
        }
        startChapter(0);
    });

    setInterval(poll, POLL);
    const loaded = frame().getAttribute("src") === source();
    if (!narrow?.matches) startChapter(0, { reuseFrame: loaded });
    else {
        if (!loaded) replaceFrame(source());
        draw();
    }
    narrow?.addEventListener("change", (event) => (event.matches ? stopTour() : startChapter(state.chapter)));
})();
