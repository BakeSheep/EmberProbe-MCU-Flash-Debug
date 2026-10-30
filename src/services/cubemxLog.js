"use strict";
const fs = require("fs");
const { createLineDecoder } = require("../../skills/_emberprobe/tool-output");

// CubeMX also runs its online updater and home-page advertisement panel in script mode. Their
// network failures are logged at ERROR level but are unrelated to code generation, so records
// from these log4j sources (simple class name) are reported as warnings instead of failures.
const BENIGN_LOG_SOURCE = /^(?:WebUtils|HomeAdPanel|[\w$]*Updater[\w$]*|[\w$]*Advert[\w$]*)$/;
// log4j records look like "[ERROR] WebUtils:658 - Updater is busy", optionally after a timestamp.
const logSource = (text) =>
    text.match(/\[(?:ERROR|FATAL|SEVERE|WARN(?:ING)?|INFO|DEBUG|TRACE)\]\s+(?:[\w$]+\.)*([\w$]+):\d+\s+-\s/i)?.[1];

// Failures that are attributable to generation block regardless of the log source.
const isGenerationFailure = (diagnostic) =>
    /\b(?:generation|generate)\s+failed\b|\bfailed\s+to\s+generate\b|\bcode\s+generation\s+(?:failed|error)\b/i.test(
        diagnostic
    ) ||
    /\b(?:firmware|package|library|dependency)\b[^\r\n]*\b(?:not\s+installed|missing|not\s+found|please.*download)\b|\b(?:please|must)\s+download\b|\b(?:download|install)\s+firmware\s+package\b/i.test(
        diagnostic
    ) ||
    /\b(?:requires?\s+migration|must\s+be\s+migrated|migration\s+required|migration\s+needed)\b|\bProject\s+migration\b/i.test(
        diagnostic
    );

const isErrorOrException = (diagnostic) =>
    /\b(?:error|fatal)\b/i.test(diagnostic) ||
    /(?:\bException\b|\bError\b):|^\s*at\s+[\w$./]+\([\w$.]+\.java:\d+\)|\b(?:NullPointerException|ClassNotFoundException|IOException|InvocationTargetException|RuntimeException)\b/i.test(
        diagnostic
    );

// A Java stack trace printed directly below a log4j record belongs to that record.
const isStackTraceLine = (text) =>
    /^(?:at\s+[\w$./<>]+\(.*\)|Caused by:.*|\.\.\.\s*\d+\s+more|(?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::.*)?)$/.test(
        text
    );

// Only the last 1 MiB of output is kept in memory; the full log goes to options.logPath.
const LOG_TAIL = 1024 * 1024;

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

    const isWarnLine = (text) => /^(?:.*?\[WARN(?:ING)?\]|WARN(?:ING)?\s*:)/i.test(text);

    // Per stream: whether unattributed stack-trace lines continue a benign log4j record.
    const benignTrace = { stdout: false, stderr: false };
    const classify = (text, streamName) => {
        const diagnostic = text.replace(/\b0\s+(?:errors?|exceptions?|failures?|failed)\b/gi, "");
        const source = logSource(text);
        let benign;
        if (source) benign = benignTrace[streamName] = BENIGN_LOG_SOURCE.test(source);
        else benign = benignTrace[streamName] = benignTrace[streamName] && isStackTraceLine(text);
        if (isGenerationFailure(diagnostic)) return "blocking";
        if (isErrorOrException(diagnostic)) {
            if (!benign) return "blocking";
            // Report the benign record once; its stack trace lines would only flood the warnings.
            return source ? "warning" : "";
        }
        return isWarnLine(text) ? "warning" : "";
    };

    const line = (text, stdout) => {
        text = text.trim();
        if (/^log4j user configuration file not found:[^\r\n]*[/\\]log4j2\.xml$/i.test(text)) return;
        const kind = classify(text, stdout ? "stdout" : "stderr");
        if (kind === "blocking") {
            failureLine ||= text.slice(0, 1000);
        } else if (kind === "warning") {
            const summaryText = text.slice(0, 500);
            if (!warnings.includes(summaryText) && warnings.length < 50) warnings.push(summaryText);
        }

        if (!stdout) return;
        const generated = text.match(/\bGenerated code:\s*(.+[/\\][^/\\]+)\s*$/i);
        if (generated && generatedFiles.size < 20000) generatedFiles.add(generated[1]);
        if (/^project\s+generate$/i.test(text)) {
            pending = true;
            confirmed = false;
        } else if (/^(?:config\b|project\b|exit$|Bye bye$)/i.test(text)) {
            pending = false;
        } else if (pending && text === "OK") {
            confirmed = true;
            pending = false;
        } else if (pending && text === "KO") {
            // Only the generate command's status is decisive: `project path` may answer KO harmlessly.
            failureLine ||= "CubeMX reported KO for project generate";
            pending = false;
        } else if (/(?:generat[^\r\n]*(?:success|succes)|(?:success|succes)[^\r\n]*generat)/i.test(text)) {
            confirmed = true;
        }
    };

    const stream = (stdout) => {
        // CubeMX is a Java program: on Windows it prints in the system code page (GBK on Chinese Windows).
        // Whole lines are decoded, keeping their line breaks, and logged as UTF-8; a last line without newline
        // arrives at the end.
        const decoder = createLineDecoder((text) => append(text), { maxPending: 65537, keepEnds: true });
        let buffer = "";
        const append = (text) => {
            // Trim only after the tail doubles, so appending stays linear instead of copying 1 MiB per line.
            log += text;
            if (log.length > 2 * LOG_TAIL) log = log.slice(-LOG_TAIL);
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
            decoder.end();
            line(buffer, stdout);
        });
        return (chunk) => {
            decoder.write(chunk);
            // A line still waiting for its newline counts toward the same per-line limit.
            if (decoder.length > 65536) failureLine ||= "CubeMX diagnostic line exceeds 64 KiB";
        };
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
            log = log.slice(-LOG_TAIL);
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
