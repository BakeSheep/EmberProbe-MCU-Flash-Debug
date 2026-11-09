"use strict";

// Records the homepage clips from the real frontend in mockup/, on a fake clock so every frame is exact.
// The clips are committed: nothing here runs in CI. See docs/development/website.md.
//
//   LIB=<folder with node_modules/playwright-core> node website/capture/record.js [--lang=zh|en] [--preview] [scene...]
//
// A scene's window is its display size, so the frontend's text stays at its real size on the page. Frames are
// taken at twice that size and encoded unscaled.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createMockServer } = require("../../mockup/serve");
const { scenes } = require("./scenes");

const SCALE = 2;
const FPS = 30;
const repository = path.join(__dirname, "../..");
const frameRoot = path.join(repository, "test-results/website-capture");
const media = path.join(__dirname, "../assets/media");
const timelineFile = path.join(media, "timeline.json");

const CURSOR =
    '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l14 11-6.4.6L14 20l-2.6 1.1-3.3-6.4L3 19z" fill="#1B1A18" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';

function playwright() {
    const root = process.env.LIB;
    return require(root ? path.join(root, "node_modules/playwright-core") : "playwright-core");
}

async function openWindow(browser, url, scene, windowSize, lang) {
    const { width, height, sidebar } = windowSize;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SCALE });
    await context.clock.install({ time: new Date("2026-11-05T10:00:00") });
    // Pause before creating a page: browser startup and font loading must not race a short future deadline.
    await context.clock.pauseAt(new Date("2026-11-05T10:00:10"));
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(`${url}?lang=${lang}&theme=light${scene.query || ""}`);
    await page.clock.runFor(3000);
    await page.addStyleTag({ content: "#toasts{display:none!important}" });
    await page.evaluate(
        (value) => document.documentElement.style.setProperty("--sidebar-width", `${value}px`),
        sidebar
    );
    await page.clock.runFor(300);
    // Only runFor moves time: a screenshot takes longer than a frame.
    const frames = {
        page: page.mainFrame(),
        sb: page.frames().find((frame) => /sidebar/.test(frame.url())),
        lw: page.frames().find((frame) => /livewatch/.test(frame.url()))
    };
    return { context, page, failures, frames, lang, sb: frames.sb, lw: frames.lw };
}

async function pump(session, milliseconds) {
    for (let left = milliseconds; left > 0; left -= 200) await session.page.clock.runFor(Math.min(200, left));
}

// Opens only the named sidebar sections.
async function openSections(session, ids) {
    await session.sb.evaluate((open) => {
        for (const section of document.querySelectorAll("details")) {
            if (section.id && !section.closest(".values")) section.open = open.includes(section.id);
        }
    }, ids);
    await session.page.clock.runFor(300);
}

async function pointOf(session, step) {
    const frame = session.frames[step.on || "sb"];
    const target =
        typeof step.to === "string" ? `document.querySelector(${JSON.stringify(step.to)})` : `(${step.to})()`;
    const rect = await frame.evaluate(`(() => {
        const box = ${target}.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
    })()`);
    const origin = frame === session.frames.page ? { x: 0, y: 0 } : await (await frame.frameElement()).boundingBox();
    const at = step.point || [0.5, 0.5];
    return { x: rect.x + rect.width * at[0] + origin.x, y: rect.y + rect.height * at[1] + origin.y };
}

async function addCursor(session) {
    await session.page.evaluate((cursor) => {
        const pointer = document.createElement("div");
        pointer.id = "captureCursor";
        pointer.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:99999;pointer-events:none";
        pointer.innerHTML = cursor;
        const ring = document.createElement("div");
        ring.id = "captureRing";
        ring.style.cssText =
            "position:fixed;width:30px;height:30px;margin:-15px;border:2px solid #d9480f;border-radius:50%;z-index:99998;pointer-events:none;opacity:0";
        document.body.append(pointer, ring);
    }, CURSOR);
}

async function drawCursor(session, position, ringAge) {
    await session.page.evaluate(
        ([x, y, age]) => {
            const pointer = document.getElementById("captureCursor").style;
            const ring = document.getElementById("captureRing").style;
            pointer.transform = `translate(${x}px,${y}px)`;
            ring.left = `${x}px`;
            ring.top = `${y}px`;
            ring.opacity = age < 1 ? String(1 - age) : "0";
            ring.transform = `scale(${0.4 + age})`;
        },
        [position.x, position.y, ringAge]
    );
}

// Runs the scene's operations with real mouse and keyboard input while stepping the clock one frame at a time.
// A still scene runs the same operations but stops at its poster frame, without a cursor.
async function take(session, scene, directory, every) {
    const { page } = session;
    const posterFrame = Math.round(scene.poster * FPS);
    const total = scene.still ? posterFrame + 1 : Math.round(scene.duration * FPS);
    const operations = scene.operations.map((operation) => ({ move: 0.5, ...operation }));
    let cursor = { x: scene.cursor[0], y: scene.cursor[1] };
    let from = cursor;
    let to = cursor;
    let moveStart = 0;
    let moveEnd = 0;
    let ring = -9;
    const typing = [];
    if (!scene.still) await addCursor(session);
    for (let index = 0; index < total; index++) {
        const time = index / FPS;
        for (const operation of operations) {
            if (operation.moved || !operation.to || time < operation.at - operation.move) continue;
            operation.moved = true;
            from = cursor;
            to = await pointOf(session, operation);
            moveStart = operation.at - operation.move;
            moveEnd = operation.at;
        }
        const progress = moveEnd > moveStart ? Math.min(1, Math.max(0, (time - moveStart) / (moveEnd - moveStart))) : 1;
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
        cursor = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
        await page.mouse.move(cursor.x, cursor.y);
        for (const operation of operations) {
            if (operation.done || time < operation.at) continue;
            operation.done = true;
            if (operation.click) {
                await page.mouse.down();
                await page.mouse.up();
                ring = time;
            }
            if (operation.press) {
                await page.mouse.down();
                ring = time;
            }
            if (operation.release) await page.mouse.up();
            if (operation.type) typing.push(...operation.type);
            if (operation.key) await page.keyboard.press(operation.key);
            if (operation.skip) await page.clock.runFor(operation.skip);
            if (operation.run) await operation.run(session);
        }
        if (typing.length && index % 2 === 0) await page.keyboard.type(typing.shift());
        if (!scene.still) await drawCursor(session, cursor, (time - ring) / 0.35);
        if (scene.still ? index === posterFrame : index % every === 0) {
            await page.screenshot({ path: path.join(directory, `${String(index).padStart(4, "0")}.png`) });
        }
        await page.clock.runFor(Math.round(((index + 1) * 1000) / FPS) - Math.round((index * 1000) / FPS));
    }
    return total;
}

function run(tool, args) {
    const result = spawnSync(tool, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${tool} failed: ${result.error || result.stderr}`);
}

const cropFilter = (crop) => `crop=${crop[2] * SCALE}:${crop[3] * SCALE}:${crop[0] * SCALE}:${crop[1] * SCALE}`;

function encode(directory, output, crf, crop) {
    const filters = crop ? [cropFilter(crop)] : [];
    filters.push("scale=out_color_matrix=bt709:out_range=tv:flags=neighbor", "format=yuv420p");
    // prettier-ignore
    run("ffmpeg", [
        "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(directory, "%04d.png"),
        "-vf", filters.join(","), "-an", "-c:v", "libx264", "-preset", "veryslow", "-crf", String(crf),
        "-profile:v", "high", "-g", String(FPS), "-color_primaries", "bt709", "-color_trc", "bt709",
        "-colorspace", "bt709", "-movflags", "+faststart", output
    ]);
}

function poster(frame, output, crop) {
    const filters = crop ? ["-vf", cropFilter(crop)] : [];
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", frame, ...filters, "-frames:v", "1", "-quality", "82", output]);
}

// One pass through the scene in the given window.
async function capture(browser, url, name, lang, windowSize, label, every) {
    const scene = scenes[name];
    const directory = path.join(frameRoot, label);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const session = await openWindow(browser, url, scene, windowSize, lang);
    await scene.prepare(session, { pump, openSections });
    const frames = await take(session, scene, directory, every);
    await session.context.close();
    if (session.failures.length) throw new Error(`${name}: ${session.failures.join("; ")}`);
    return { directory, frames };
}

// A wide scene's phone version is a crop of the same pass. A panel's is a second pass in a narrower window, so
// its text stays readable instead of being scaled down.
async function record(browser, url, name, lang, preview) {
    const scene = scenes[name];
    const every = preview ? 15 : 1;
    const main = await capture(browser, url, name, lang, scene.window, `${name}-${lang}`, every);
    const second = scene.compact
        ? await capture(browser, url, name, lang, scene.compact.window, `${name}-${lang}-compact`, every)
        : null;
    if (preview) return console.log(`${name}-${lang}: preview frames in ${main.directory}`);

    fs.mkdirSync(media, { recursive: true });
    const framePath = (directory) =>
        path.join(directory, `${String(Math.round(scene.poster * FPS)).padStart(4, "0")}.png`);
    const crf = scene.crf || 24;
    if (!scene.still) encode(main.directory, path.join(media, `${name}-${lang}.mp4`), crf, scene.crop);
    poster(framePath(main.directory), path.join(media, `${name}-${lang}.webp`), scene.crop);
    const narrowSource = second || (scene.narrow && main);
    const narrowCrop = scene.compact ? scene.compact.crop : scene.narrow;
    if (narrowSource) {
        if (!scene.still)
            encode(narrowSource.directory, path.join(media, `${name}-${lang}-narrow.mp4`), crf, narrowCrop);
        poster(framePath(narrowSource.directory), path.join(media, `${name}-${lang}-narrow.webp`), narrowCrop);
    }
    const timeline = fs.existsSync(timelineFile) ? JSON.parse(fs.readFileSync(timelineFile, "utf8")) : {};
    const size = {
        width: scene.crop ? scene.crop[2] : scene.window.width,
        height: scene.crop ? scene.crop[3] : scene.window.height,
        narrow: narrowCrop ? narrowCrop.slice(2) : undefined
    };
    // A still needs only its dimensions; a clip also keeps its duration and steps.
    timeline[name] = scene.still
        ? { still: true, ...size }
        : { duration: main.frames / FPS, ...size, steps: scene.steps };
    fs.writeFileSync(timelineFile, `${JSON.stringify(timeline, null, 4)}\n`);
    if (scene.still) console.log(`${name}-${lang}: still written`);
    for (const suffix of scene.still ? [] : narrowCrop ? ["", "-narrow"] : [""]) {
        const file = path.join(media, `${name}-${lang}${suffix}.mp4`);
        console.log(`${path.basename(file)}: ${(fs.statSync(file).size / 1048576).toFixed(2)} MB`);
    }
    fs.rmSync(main.directory, { recursive: true, force: true });
    if (second) fs.rmSync(second.directory, { recursive: true, force: true });
}

async function main() {
    const args = process.argv.slice(2);
    const langs = args.filter((arg) => arg.startsWith("--lang=")).map((arg) => arg.slice(7));
    const names = args.filter((arg) => !arg.startsWith("--"));
    const preview = args.includes("--preview");
    run(process.execPath, [path.join(repository, "mockup/build.js")]);
    const server = createMockServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const browser = await playwright().chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
    try {
        for (const name of names.length ? names : Object.keys(scenes)) {
            for (const lang of langs.length ? langs : ["zh", "en"]) await record(browser, url, name, lang, preview);
        }
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
