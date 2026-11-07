"use strict";

// Walks every chapter of the guided tour with real mouse and keyboard input, in the built site, in both languages.
// Needs `node website/build.js` first and the same LIB as record.js:
//   LIB=<dir with node_modules/playwright-core> node website/capture/check-tour.js [--lang=zh|en] [chapter...]
const path = require("path");
const { output } = require("../build");
const { createSiteServer, base } = require("../serve");
const { chapters } = require("../tour-data");

const { chromium } = require(path.join(process.env.LIB || ".", "node_modules/playwright-core"));
const STEP_TIMEOUT = 15000;

function frameOf(page, step) {
    if (step.frame === "shell") return page.frames().find((frame) => /\/editor\/\?/.test(frame.url()));
    const name = step.frame === "chart" ? /livewatch/ : /sidebar/;
    return page.frames().find((frame) => name.test(frame.url()));
}

async function spotCenter(page) {
    const spot = page.locator("#tour-spot");
    await spot.waitFor({ state: "attached", timeout: STEP_TIMEOUT });
    await page.waitForFunction(() => !document.getElementById("tour-spot").hidden, null, { timeout: STEP_TIMEOUT });
    // Let the highlight settle on its target: the sidebar may still be scrolling.
    let box = await spot.boundingBox();
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(100);
        const next = await spot.boundingBox();
        if (next && box && next.x === box.x && next.y === box.y && next.width === box.width) break;
        box = next;
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// Only the thumbs of the history range take input.
async function drag(page, box, frame, step) {
    const y = box.y + box.height / 2;
    const from = await frame.evaluate(
        (selector) => {
            const range = document.querySelector(selector);
            return (range.value - range.min) / (range.max - range.min);
        },
        typeof step.target === "string" ? step.target : "#chartFromRange"
    );
    await page.mouse.move(box.x + 10 + (box.width - 20) * from, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (from < 0.5 ? from + 0.5 : from * 0.3), y, { steps: 8 });
    await page.mouse.up();
}

async function perform(page, step) {
    if (typeof step.done === "function" && String(step.target) !== "#varSearch") return;
    const { x, y, box } = await spotCenter(page);
    if (step.done === "read") return page.locator(".tour-button.primary").click();
    if (step.done === "hover") {
        await page.mouse.move(x - 12, y);
        return page.mouse.move(x, y);
    }
    if (step.done === "input") {
        const frame = frameOf(page, step);
        if (typeof step.target === "string" && step.target.endsWith("select"))
            return frame.selectOption(step.target, "winusb");
        return drag(page, box, frame, step);
    }
    await page.mouse.click(x, y);
    if (typeof step.done === "function") return page.keyboard.type("target", { delay: 20 });
    if (step.done === "enter") {
        await page.keyboard.press("Control+a");
        await page.keyboard.type("2400");
        await page.keyboard.press("Enter");
    }
}

async function walk(browser, url, lang, wanted) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") failures.push(message.text());
    });
    await page.goto(`${url}demo/?lang=${lang}`);
    for (const [index, chapter] of chapters.entries()) {
        if (wanted.length && !wanted.includes(chapter.id)) continue;
        if (index > 0) await page.locator(".tour-chapter").nth(index).locator("button").first().click();
        await page.waitForFunction(() => !document.body.classList.contains("tour-preparing"), null, { timeout: 30000 });
        await page.waitForSelector(".tour-actions", { timeout: 30000 });
        for (const [position, step] of chapter.steps.entries()) {
            const label = `${lang} ${chapter.id} ${position + 1}`;
            try {
                await perform(page, step);
                await page.waitForFunction(
                    (count) => document.querySelectorAll(".tour-chapter.current .tour-step.done").length >= count,
                    position + 1,
                    { timeout: STEP_TIMEOUT }
                );
            } catch (error) {
                failures.push(`${label}: ${error.message.split("\n")[0]}`);
                if (process.env.TOUR_SHOTS) {
                    const name = `${chapter.id}-${position + 1}.png`;
                    await page.screenshot({ path: path.join(process.env.TOUR_SHOTS, name) });
                }
                const skip = page.locator(".tour-button", { hasText: /跳过|Skip/ });
                if (await skip.count()) await skip.click();
            }
            await page.waitForTimeout(150);
        }
        const finished = await page.locator(".tour-chapter.current.done").count();
        if (!finished) failures.push(`${lang} ${chapter.id}: not marked complete`);
        console.log(`${lang} ${chapter.id}: ${chapter.steps.length} steps`);
    }
    await context.close();
    return failures;
}

(async () => {
    const options = process.argv.slice(2);
    const lang = options.find((option) => option.startsWith("--lang="))?.slice(7);
    const wanted = options.filter((option) => !option.startsWith("--"));
    const server = createSiteServer(output);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const url = `http://127.0.0.1:${server.address().port}${base}`;
    const failures = [];
    for (const language of lang ? [lang] : ["zh", "en"]) failures.push(...(await walk(browser, url, language, wanted)));
    await browser.close();
    server.close();
    if (failures.length) {
        console.error(failures.join("\n"));
        process.exitCode = 1;
    } else console.log("Tour walked without failures");
})();
