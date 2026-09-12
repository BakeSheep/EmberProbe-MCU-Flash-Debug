"use strict";
const { StringDecoder } = require("string_decoder");

function createLogMonitor() {
    let log = "";
    let pending = false;
    let confirmed = false;
    let failureLine = "";
    const generatedFiles = new Set();
    const streams = [];
    const line = (text, stdout) => {
        text = text.trim();
        if (/^log4j user configuration file not found:[^\r\n]*[/\\]log4j2\.xml$/i.test(text)) return;
        const diagnostic = text.replace(/\b0\s+(?:errors?|exceptions?|failures?|failed)\b/gi, "");
        if (
            /\b(?:error|fatal|exception|failed|migration|migrate)\b|not installed|not found|please.*download/i.test(
                diagnostic
            )
        )
            failureLine ||= text.slice(0, 1000);
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
            return {
                log,
                confirmed,
                failureLine,
                generatedFiles: [...generatedFiles],
                diagnostic: log.split(/\r?\n/).slice(-100).join("\n").slice(-16384)
            };
        }
    };
}
module.exports = { createLogMonitor };
