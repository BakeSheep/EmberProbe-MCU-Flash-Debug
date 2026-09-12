"use strict";
const fs = require("fs");
const { StringDecoder } = require("string_decoder");

function createLogMonitor(options = {}) {
    let log = "";
    let pending = false;
    let confirmed = false;
    let failureLine = "";
    const generatedFiles = new Set();
    const warnings = [];
    const streams = [];
    let logFd = null;
    if (options.logPath) {
        try {
            logFd = fs.openSync(options.logPath, "w");
        } catch {
            logFd = null;
        }
    }

    const isWarnLine = (text) => /\b(?:warn|warning)\b/i.test(text);

    const isBlockingLine = (text) => {
        const diagnostic = text.replace(/\b0\s+(?:errors?|exceptions?|failures?|failed)\b/gi, "");
        if (isWarnLine(diagnostic)) return false;
        if (/\b(?:error|fatal)\b/i.test(diagnostic)) return true;
        if (
            /(?:\bException\b|\bError\b):|^\s*at\s+[\w$./]+\([\w$.]+\.java:\d+\)|\b(?:NullPointerException|ClassNotFoundException|IOException|InvocationTargetException|RuntimeException)\b/i.test(
                diagnostic
            )
        )
            return true;
        if (
            /\b(?:generation|generate)\s+failed\b|\bfailed\s+to\s+generate\b|\bcode\s+generation\s+(?:failed|error)\b/i.test(
                diagnostic
            )
        )
            return true;
        if (
            /\b(?:firmware|package|library|dependency)\b[^\r\n]*\b(?:not\s+installed|missing|not\s+found|please.*download)\b|\b(?:please|must)\s+download\b|\b(?:download|install)\s+firmware\s+package\b/i.test(
                diagnostic
            )
        )
            return true;
        if (
            /\b(?:requires?\s+migration|must\s+be\s+migrated|migration\s+required|migration\s+needed)\b|\bProject\s+migration\b/i.test(
                diagnostic
            )
        )
            return true;
        return false;
    };

    const line = (text, stdout) => {
        text = text.trim();
        if (/^log4j user configuration file not found:[^\r\n]*[/\\]log4j2\.xml$/i.test(text)) return;
        if (isWarnLine(text)) {
            const summaryText = text.slice(0, 500);
            if (!warnings.includes(summaryText) && warnings.length < 50) warnings.push(summaryText);
        } else if (isBlockingLine(text)) {
            failureLine ||= text.slice(0, 1000);
        }

        if (!stdout) return;
        const generated = text.match(/\bGenerated code:\s*(.+[/\\]main\.c)\s*$/i);
        if (generated && generatedFiles.size < 32) generatedFiles.add(generated[1]);
        if (/^project\s+generate$/i.test(text)) {
            pending = true;
            confirmed = false;
        } else if (/^(?:config\b|project\b|exit$|Bye bye$)/i.test(text)) {
            pending = false;
        } else if (pending && text === "OK") {
            confirmed = true;
            pending = false;
        } else if (/(?:generat[^\r\n]*(?:success|succes)|(?:success|succes)[^\r\n]*generat)/i.test(text)) {
            confirmed = true;
        }
    };

    const stream = (stdout) => {
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        const append = (text) => {
            log = (log + text).slice(-1024 * 1024);
            if (logFd !== null) {
                try {
                    fs.writeSync(logFd, text);
                } catch {
                    /* ignore */
                }
            }
            buffer += text;
            let end;
            while ((end = buffer.indexOf("\n")) !== -1) {
                const next = buffer.slice(0, end);
                if (next.length > 65536) failureLine ||= "CubeMX diagnostic line exceeds 64 KiB";
                else line(next, stdout);
                buffer = buffer.slice(end + 1);
            }
            if (buffer.length > 65536) {
                failureLine ||= "CubeMX diagnostic line exceeds 64 KiB";
                buffer = buffer.slice(-65536);
            }
        };
        streams.push(() => {
            append(decoder.end());
            line(buffer, stdout);
        });
        return (chunk) => append(decoder.write(chunk));
    };

    return {
        stdout: stream(true),
        stderr: stream(false),
        finish() {
            for (const finish of streams) finish();
            if (logFd !== null) {
                try {
                    fs.closeSync(logFd);
                } catch {
                    /* ignore */
                }
                logFd = null;
            }
            return {
                log,
                confirmed,
                failureLine,
                generatedFiles: [...generatedFiles],
                warnings: [...warnings],
                warningSummary: warnings.slice(0, 20).join("\n"),
                logPath: options.logPath || null,
                diagnostic: log.split(/\r?\n/).slice(-100).join("\n").slice(-16384)
            };
        }
    };
}
module.exports = { createLogMonitor };
