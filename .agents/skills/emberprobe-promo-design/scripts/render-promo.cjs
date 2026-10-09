#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

function parseArgs(argv) {
    const allowed = new Set([
        "input",
        "width",
        "height",
        "preview-width",
        "output",
        "preview",
        "report",
        "modules",
        "browser-path",
        "stage-selector",
        "copy-selector",
        "timeout"
    ]);
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const option = argv[index];
        if (!option.startsWith("--") || !allowed.has(option.slice(2))) throw new Error(`Unknown option: ${option}`);
        if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Missing value: ${option}`);
        if (Object.hasOwn(values, option.slice(2))) throw new Error(`Duplicate option: ${option}`);
        values[option.slice(2)] = argv[index + 1];
    }
    if (!values.input) throw new Error("Provide --input <local-html-file>");
    const positiveInteger = (key, fallback, maximum) => {
        const value = Number(values[key] ?? fallback);
        if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid --${key}: ${value}`);
        return value;
    };
    const width = positiveInteger("width", 3840, 8192);
    const height = positiveInteger("height", 2160, 8192);
    if (width * height > 40000000) throw new Error("Canvas exceeds 40 million pixels");
    const previewWidth = positiveInteger("preview-width", Math.min(1600, width), width);
    const input = path.resolve(values.input);
    if (!/\.html?$/i.test(input)) throw new Error("Input must be an HTML file");
    const base = input.replace(/\.html?$/i, "");
    const output = path.resolve(values.output ?? `${base}.png`);
    const preview = path.resolve(values.preview ?? `${base}.preview.png`);
    const report = path.resolve(values.report ?? `${base}.render.json`);
    if (!/\.png$/i.test(output) || !/\.png$/i.test(preview) || !/\.json$/i.test(report)) {
        throw new Error("Output and preview must be .png files; report must be a .json file");
    }
    const targets = [input, output, preview, report].map((item) =>
        process.platform === "win32" ? item.toLowerCase() : item
    );
    if (new Set(targets).size !== 4) throw new Error("Input and output paths must be distinct");
    return {
        input,
        output,
        preview,
        report,
        width,
        height,
        previewWidth,
        timeout: positiveInteger("timeout", 15000, 120000),
        modules: values.modules ? path.resolve(values.modules) : undefined,
        browserPath: values["browser-path"] ? path.resolve(values["browser-path"]) : undefined,
        stageSelector: values["stage-selector"] ?? "[data-promo-stage]",
        copySelector: values["copy-selector"] ?? "[data-promo-copy]"
    };
}

function loadPlaywright(options) {
    if (options.modules) return require(path.join(options.modules, "playwright"));
    const fromWorkspace = createRequire(path.join(process.cwd(), "package.json"));
    try {
        return fromWorkspace("playwright");
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
    try {
        return require("playwright");
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
        throw new Error("Playwright is unavailable. Use --modules <existing-node-modules-directory>");
    }
}

async function capture(browser, options, density) {
    const context = await browser.newContext({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: density,
        locale: "zh-CN",
        colorScheme: "light",
        reducedMotion: "reduce"
    });
    try {
        const page = await context.newPage();
        const loadErrors = [];
        page.on("pageerror", (error) => loadErrors.push(`Page script: ${error.message}`));
        page.on("requestfailed", (request) =>
            loadErrors.push(`Resource: ${request.url()} (${request.failure()?.errorText})`)
        );
        page.on("response", (response) => {
            if (response.status() >= 400) loadErrors.push(`Resource: ${response.url()} (HTTP ${response.status()})`);
        });
        page.setDefaultTimeout(options.timeout);
        await page.goto(pathToFileURL(options.input).href, { waitUntil: "load", timeout: options.timeout });
        await page.addStyleTag({
            content:
                "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"
        });
        await page.waitForFunction(
            () => document.fonts.status === "loaded" && [...document.images].every((image) => image.complete)
        );
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
                [...document.images].filter((image) => image.naturalWidth > 0).map((image) => image.decode())
            );
        });
        const audit = await page.evaluate(({ stageSelector, copySelector, width, height }) => {
            const issues = [];
            const tolerance = 1.5;
            const rect = (element) => {
                const box = element.getBoundingClientRect();
                return {
                    x: box.x,
                    y: box.y,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height
                };
            };
            const label = (element) =>
                element.getAttribute("aria-label") || element.textContent.trim().slice(0, 80) || element.tagName;
            const outside = (inner, outer) =>
                inner.x < outer.x - tolerance ||
                inner.y < outer.y - tolerance ||
                inner.right > outer.right + tolerance ||
                inner.bottom > outer.bottom + tolerance;
            const intersects = (left, right) =>
                Math.min(left.right, right.right) - Math.max(left.x, right.x) > tolerance &&
                Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y) > tolerance;
            const visible = (element) => {
                const style = getComputedStyle(element);
                const box = rect(element);
                return (
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    Number(style.opacity) > 0 &&
                    box.width > 0 &&
                    box.height > 0
                );
            };
            const canvas = { x: 0, y: 0, right: width, bottom: height };
            const stages = document.querySelectorAll(stageSelector);
            if (stages.length !== 1) issues.push({ type: "stage-count", expected: 1, actual: stages.length });
            const stage = stages[0];
            if (stage) {
                const box = rect(stage);
                if (
                    Math.abs(box.x) > tolerance ||
                    Math.abs(box.y) > tolerance ||
                    Math.abs(box.width - width) > tolerance ||
                    Math.abs(box.height - height) > tolerance
                ) {
                    issues.push({ type: "stage-size", expected: { width, height }, actual: box });
                }
            }
            const images = [...document.images].map((image) => ({
                alt: image.alt,
                width: image.naturalWidth,
                height: image.naturalHeight,
                source: image.src.startsWith("data:") ? "embedded" : image.getAttribute("src")
            }));
            for (const image of images) {
                if (image.width === 0 || image.height === 0) issues.push({ type: "missing-image", ...image });
            }
            const copies = [...document.querySelectorAll(copySelector)].filter(visible);
            if (copies.length === 0)
                issues.push({ type: "copy-markers", message: "Mark visible copy blocks for layout checks" });
            if (copies.length > 200) throw new Error("Limit copy markers to 200 independent blocks");
            const measured = copies.map((element) => ({ element, label: label(element), box: rect(element) }));
            for (const item of measured) {
                if (outside(item.box, canvas))
                    issues.push({ type: "copy-outside-canvas", label: item.label, box: item.box });
                if (item.element.clientWidth > 0 && item.element.scrollWidth > item.element.clientWidth + tolerance) {
                    issues.push({ type: "copy-overflow", label: item.label, axis: "horizontal" });
                }
                // Font metrics may exceed a tight line box without clipping visible glyphs.
                const overflowY = getComputedStyle(item.element).overflowY;
                if (
                    ["hidden", "clip", "scroll", "auto"].includes(overflowY) &&
                    item.element.clientHeight > 0 &&
                    item.element.scrollHeight > item.element.clientHeight + tolerance
                ) {
                    issues.push({ type: "copy-overflow", label: item.label, axis: "vertical" });
                }
                const walker = document.createTreeWalker(item.element, NodeFilter.SHOW_TEXT);
                let node;
                let clipped = false;
                while ((node = walker.nextNode()) && !clipped) {
                    if (!node.textContent.trim()) continue;
                    if (!visible(node.parentElement)) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const textBox of range.getClientRects()) {
                        if (textBox.width === 0 || textBox.height === 0) continue;
                        if (
                            outside(
                                { x: textBox.x, y: textBox.y, right: textBox.right, bottom: textBox.bottom },
                                canvas
                            )
                        ) {
                            issues.push({ type: "text-outside-canvas", label: item.label });
                            clipped = true;
                            break;
                        }
                        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                            const style = getComputedStyle(parent);
                            const parentBox = rect(parent);
                            const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
                            const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
                            if (
                                (clipsX &&
                                    (textBox.x < parentBox.x - tolerance ||
                                        textBox.right > parentBox.right + tolerance)) ||
                                (clipsY &&
                                    (textBox.y < parentBox.y - tolerance ||
                                        textBox.bottom > parentBox.bottom + tolerance))
                            ) {
                                issues.push({ type: "text-clipped", label: item.label, ancestor: parent.tagName });
                                clipped = true;
                                break;
                            }
                        }
                        if (clipped) break;
                    }
                }
            }
            for (let left = 0; left < measured.length; left += 1) {
                for (let right = left + 1; right < measured.length; right += 1) {
                    const a = measured[left];
                    const b = measured[right];
                    if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
                    if (intersects(a.box, b.box)) issues.push({ type: "copy-overlap", labels: [a.label, b.label] });
                }
            }
            const protectedRegions = [...document.querySelectorAll("[data-promo-safe]")].filter(visible);
            for (const region of protectedRegions) {
                for (const item of measured) {
                    if (region.contains(item.element) || item.element.contains(region)) continue;
                    if (intersects(rect(region), item.box))
                        issues.push({ type: "protected-region-overlap", copy: item.label, region: label(region) });
                }
            }
            return {
                issues,
                stage: stage ? rect(stage) : null,
                images,
                copyCount: measured.length,
                protectedRegionCount: protectedRegions.length,
                declaredFonts: [...new Set(copies.map((element) => getComputedStyle(element).fontFamily))]
            };
        }, options);
        const png = await page.screenshot({ type: "png", animations: "disabled", fullPage: false });
        const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        if (
            dimensions.width !== Math.round(options.width * density) ||
            dimensions.height !== Math.round(options.height * density)
        ) {
            audit.issues.push({ type: "export-size", actual: dimensions, expectedDensity: density });
        }
        audit.issues.push(...loadErrors.map((message) => ({ type: "load-error", message })));
        return { png, dimensions, audit };
    } finally {
        await context.close();
    }
}

async function main() {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
        process.stdout.write(
            "Usage: node render-promo.cjs --input poster.html [--width 3840 --height 2160 --preview-width 1600 --modules /path/to/node_modules --browser-path /path/to/chrome]\nSee references/rendering.md for selectors and output options.\n"
        );
        return;
    }
    const options = parseArgs(process.argv.slice(2));
    if (!(await fs.stat(options.input)).isFile()) throw new Error("Input must be a local HTML file");
    const { chromium } = loadPlaywright(options);
    const browser = await chromium.launch({ headless: true, executablePath: options.browserPath });
    try {
        const highResolution = await capture(browser, options, 1);
        const preview = await capture(browser, options, options.previewWidth / options.width);
        const report = {
            ok: highResolution.audit.issues.length === 0 && preview.audit.issues.length === 0,
            input: options.input,
            outputs: [
                { path: options.output, ...highResolution.dimensions },
                { path: options.preview, ...preview.dimensions }
            ],
            audits: { highResolution: highResolution.audit, preview: preview.audit },
            visualReviewRequired: true
        };
        for (const filename of [options.output, options.preview, options.report])
            await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(options.output, highResolution.png);
        await fs.writeFile(options.preview, preview.png);
        await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(
            `${JSON.stringify({ ok: report.ok, outputs: report.outputs, report: options.report, issueCount: highResolution.audit.issues.length + preview.audit.issues.length }, null, 2)}\n`
        );
        if (!report.ok) process.exitCode = 1;
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
