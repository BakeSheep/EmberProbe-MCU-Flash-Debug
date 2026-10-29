"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeBackgroundIcon = factory();
})(globalThis, function () {
    const MAX_FILE_BYTES = 4 * 1024 * 1024;
    const MAX_SIDE = 512;
    function fail(code) {
        throw Object.assign(new Error(code), { code });
    }
    function pngSize(bytes) {
        if (
            bytes.length < 33 ||
            ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) ||
            bytes[8] !== 0 ||
            bytes[9] !== 0 ||
            bytes[10] !== 0 ||
            bytes[11] !== 13 ||
            String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
        )
            fail("invalid");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = view.getUint32(16),
            height = view.getUint32(20);
        if (!width || !height) fail("invalid");
        if (width > 4096 || height > 4096 || width * height > 16000000) fail("size");
        return { width, height };
    }
    // Shared with the host: only bounded, canonical alpha bytes cross the persistence boundary.
    function validate(icon) {
        if (
            !icon ||
            icon.version !== 1 ||
            !Number.isInteger(icon.width) ||
            !Number.isInteger(icon.height) ||
            icon.width < 1 ||
            icon.height < 1 ||
            icon.width > MAX_SIDE ||
            icon.height > MAX_SIDE ||
            typeof icon.alphaBase64 !== "string" ||
            icon.alphaBase64.length !== 4 * Math.ceil((icon.width * icon.height) / 3) ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(icon.alphaBase64)
        )
            fail("invalid");
        const binary = atob(icon.alphaBase64);
        if (binary.length !== icon.width * icon.height || btoa(binary) !== icon.alphaBase64) fail("invalid");
        const alpha = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        if (!alpha.some((v) => v)) fail("empty");
        return { version: 1, width: icon.width, height: icon.height, alphaBase64: icon.alphaBase64 };
    }
    function encode(width, height, alpha) {
        let binary = "";
        for (let i = 0; i < alpha.length; i += 8192) binary += String.fromCharCode(...alpha.subarray(i, i + 8192));
        return { version: 1, width, height, alphaBase64: btoa(binary) };
    }
    function extract(width, height, rgba) {
        if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width < 1 ||
            height < 1 ||
            width > 4096 ||
            height > 4096 ||
            width * height > 16000000 ||
            rgba.length !== width * height * 4
        )
            fail("size");
        const alpha = new Uint8Array(width * height);
        let transparent = false;
        for (let i = 0; i < alpha.length; i++) {
            alpha[i] = rgba[i * 4 + 3];
            if (alpha[i] < 255) transparent = true;
        }
        if (!transparent) {
            const border = [];
            for (let x = 0; x < width; x++) {
                border.push(x);
                if (height > 1) border.push((height - 1) * width + x);
            }
            for (let y = 1; y < height - 1; y++) {
                border.push(y * width);
                if (width > 1) border.push(y * width + width - 1);
            }
            // Channel medians tolerate a logo touching a small portion of the border.
            const bg = [0, 1, 2].map((c) => {
                const values = border.map((i) => rgba[i * 4 + c]).sort((a, b) => a - b);
                return values[Math.floor(values.length / 2)];
            });
            const distance = (i) =>
                Math.max(
                    Math.abs(rgba[i * 4] - bg[0]),
                    Math.abs(rgba[i * 4 + 1] - bg[1]),
                    Math.abs(rgba[i * 4 + 2] - bg[2])
                );
            if (border.filter((i) => distance(i) <= 24).length < border.length * 0.9) fail("background");
            const seen = new Uint8Array(alpha.length),
                queue = new Uint32Array(alpha.length);
            let head = 0,
                tail = 0;
            function visit(i) {
                if (seen[i]) return;
                seen[i] = 1;
                const d = distance(i);
                if (d > 48) return;
                alpha[i] = Math.round((255 * Math.max(0, d - 16)) / 32);
                if (d <= 24) queue[tail++] = i;
            }
            border.forEach(visit);
            while (head < tail) {
                const i = queue[head++],
                    x = i % width;
                if (x) visit(i - 1);
                if (x + 1 < width) visit(i + 1);
                if (i >= width) visit(i - width);
                if (i + width < alpha.length) visit(i + width);
            }
        }
        let left = width,
            top = height,
            right = -1,
            bottom = -1;
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                if (!alpha[y * width + x]) continue;
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        if (right < left) fail("empty");
        const cw = right - left + 1,
            ch = bottom - top + 1;
        const scale = Math.min(1, MAX_SIDE / Math.max(cw, ch));
        const w = Math.max(1, Math.round(cw * scale)),
            h = Math.max(1, Math.round(ch * scale));
        const result = new Uint8Array(w * h);
        // Area averaging preserves thin features and alpha coverage when reducing the cropped mask.
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const x0 = (x * cw) / w,
                    x1 = ((x + 1) * cw) / w,
                    y0 = (y * ch) / h,
                    y1 = ((y + 1) * ch) / h;
                let sum = 0;
                for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
                    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++)
                        sum +=
                            alpha[(top + sy) * width + left + sx] *
                            (Math.min(sx + 1, x1) - Math.max(sx, x0)) *
                            (Math.min(sy + 1, y1) - Math.max(sy, y0));
                result[y * w + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
            }
        return validate(encode(w, h, result));
    }
    async function importFile(file, env = globalThis) {
        if (!file || file.size > MAX_FILE_BYTES) fail("size");
        const header = new Uint8Array(await file.slice(0, 33).arrayBuffer());
        const size = pngSize(header);
        let bitmap;
        try {
            bitmap = await env.createImageBitmap(file);
            if (bitmap.width !== size.width || bitmap.height !== size.height) fail("invalid");
            const canvas = env.document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            return extract(size.width, size.height, ctx.getImageData(0, 0, size.width, size.height).data);
        } catch (error) {
            if (["size", "background", "empty"].includes(error.code)) throw error;
            fail("invalid");
        } finally {
            if (bitmap) bitmap.close();
        }
    }
    function tinted(icon, color, document) {
        const canvas = document.createElement("canvas");
        canvas.width = icon.width;
        canvas.height = icon.height;
        const ctx = canvas.getContext("2d");
        const pixels = ctx.createImageData(icon.width, icon.height);
        const binary = atob(icon.alphaBase64);
        for (let i = 0; i < binary.length; i++) pixels.data[i * 4 + 3] = binary.charCodeAt(i);
        ctx.putImageData(pixels, 0, 0);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, icon.width, icon.height);
        return canvas;
    }
    function paint(ctx, bitmap, geometry) {
        const { padL, padT, pw, ph } = geometry;
        const scale = Math.min((pw * 0.6) / bitmap.width, (ph * 0.6) / bitmap.height);
        const w = bitmap.width * scale,
            h = bitmap.height * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, padT, pw, ph);
        ctx.clip();
        ctx.globalAlpha = 0.06;
        ctx.drawImage(bitmap, padL + (pw - w) / 2, padT + (ph - h) / 2, w, h);
        ctx.restore();
    }
    return { MAX_FILE_BYTES, pngSize, validate, extract, importFile, tinted, paint };
});
