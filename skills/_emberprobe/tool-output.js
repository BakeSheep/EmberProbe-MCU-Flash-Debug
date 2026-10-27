"use strict";

// OpenOCD and GDB print their own text as ASCII/UTF-8, but on Windows the system messages they quote
// (FormatMessage for WSAGetLastError, file errors) come in the ANSI code page of the system locale, such
// as GBK on Chinese Windows, and Java tools such as CubeMX print everything in it. Each line is decoded as
// UTF-8 and falls back to that code page only when UTF-8 cannot represent it. Shared by the extension and
// the standalone skills, so it depends on nothing outside Node.
const ANSI_BY_LANGUAGE = {
    zh: "gbk",
    ja: "shift_jis",
    ko: "euc-kr",
    th: "windows-874",
    ru: "windows-1251",
    uk: "windows-1251",
    be: "windows-1251",
    bg: "windows-1251",
    sr: "windows-1251",
    mk: "windows-1251",
    pl: "windows-1250",
    cs: "windows-1250",
    sk: "windows-1250",
    hu: "windows-1250",
    hr: "windows-1250",
    sl: "windows-1250",
    ro: "windows-1250",
    el: "windows-1253",
    tr: "windows-1254",
    he: "windows-1255",
    ar: "windows-1256",
    fa: "windows-1256",
    et: "windows-1257",
    lv: "windows-1257",
    lt: "windows-1257",
    vi: "windows-1258"
};

function systemLocale() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().locale || "";
    } catch {
        return "";
    }
}

function ansiEncoding(locale = systemLocale()) {
    const [language, ...rest] = String(locale).toLowerCase().split(/[-_]/);
    // Traditional Chinese locales use Big5; zh-CN, zh-SG and zh-Hans use GBK.
    if (language === "zh" && rest.some((part) => ["tw", "hk", "mo", "hant"].includes(part))) return "big5";
    return ANSI_BY_LANGUAGE[language] || "windows-1252";
}

/**
 * @param {Buffer} bytes
 * @param {{ platform?: string, locale?: string, maxPending?: number, keepEnds?: boolean }} [options]
 */
function decodeLine(bytes, { platform = process.platform, locale = undefined } = {}) {
    const text = bytes.toString("utf8");
    if (platform !== "win32" || !text.includes("�")) return text;
    try {
        const local = new TextDecoder(ansiEncoding(locale)).decode(bytes);
        return local.includes("�") ? text : local;
    } catch {
        return text;
    }
}

// Splits a byte stream into decoded lines without cutting a multi-byte character in half. keepEnds hands each
// line over with its own line break, for callers that keep the output as it was.
/**
 * @param {(line: string) => void} onLine
 * @param {{ platform?: string, locale?: string, maxPending?: number, keepEnds?: boolean }} [options]
 */
function createLineDecoder(onLine, options = {}) {
    /** @type {Buffer} */
    let pending = Buffer.alloc(0);
    const maxPending = options.maxPending || 65536;
    return {
        // Bytes waiting for their newline, for callers that cap line length.
        get length() {
            return pending.length;
        },
        write(chunk) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
            let start = 0;
            for (let index = pending.indexOf(10); index !== -1; index = pending.indexOf(10, start)) {
                const end = index > start && pending[index - 1] === 13 ? index - 1 : index;
                const ending = options.keepEnds ? (end < index ? "\r\n" : "\n") : "";
                onLine(decodeLine(pending.subarray(start, end), options) + ending);
                start = index + 1;
            }
            pending = pending.subarray(start);
            if (pending.length > maxPending) pending = pending.subarray(pending.length - maxPending);
        },
        // Emits a final line that had no newline.
        end() {
            if (pending.length) onLine(decodeLine(pending, options));
            pending = Buffer.alloc(0);
        }
    };
}

// Decodes a whole captured output (execFile with encoding "buffer") line by line; CRLF becomes LF.
/**
 * @param {Buffer | string | null | undefined} output
 * @param {{ platform?: string, locale?: string }} [options]
 */
function decodeOutput(output, options = {}) {
    if (output == null) return "";
    if (typeof output === "string") return output;
    const lines = [];
    const decoder = createLineDecoder((line) => lines.push(line), { ...options, maxPending: Infinity });
    decoder.write(output);
    decoder.end();
    return lines.join("\n") + (output.length && output[output.length - 1] === 10 ? "\n" : "");
}

module.exports = { ansiEncoding, decodeLine, createLineDecoder, decodeOutput };
