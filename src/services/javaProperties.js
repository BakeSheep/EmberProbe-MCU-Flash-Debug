"use strict";
const { failure } = require("./cubemxEnvironment");

function parseProperties(content, records = []) {
    const values = Object.create(null);
    const lines = content.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
    const decode = (text, line) => {
        let result = "";
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== "\\") {
                result += text[i];
                continue;
            }
            const escaped = text[++i];
            if (escaped === "u") {
                const digits = text.slice(i + 1, i + 5);
                if (!/^[0-9a-f]{4}$/i.test(digits))
                    throw failure("CUBEMX_IOC_INVALID", "Malformed Unicode escape", { line, content: lines[line - 1] });
                result += String.fromCharCode(parseInt(digits, 16));
                i += 4;
            } else result += { t: "\t", n: "\n", r: "\r", f: "\f" }[escaped] ?? escaped ?? "";
        }
        return result;
    };
    for (let index = 0; index < lines.length; index++) {
        const line = index + 1;
        let logical = lines[index].replace(/^[ \t\f]+/, "");
        if (!logical || /^[#!]/.test(logical)) continue;
        while ((logical.match(/\\+$/)?.[0].length || 0) % 2 === 1) {
            logical = logical.slice(0, -1);
            if (++index >= lines.length) break;
            logical += lines[index].replace(/^[ \t\f]+/, "");
        }
        let end = 0;
        for (; end < logical.length; end++) {
            if (logical[end] === "\\") {
                end++;
                continue;
            }
            if (/[=: \t\f]/.test(logical[end])) break;
        }
        let start = end;
        while (/[ \t\f]/.test(logical[start] || "x")) start++;
        if (logical[start] === "=" || logical[start] === ":") start++;
        while (/[ \t\f]/.test(logical[start] || "x")) start++;
        const key = decode(logical.slice(0, end), line);
        if (!key || Object.hasOwn(values, key))
            throw failure("CUBEMX_IOC_INVALID", "Empty or duplicate .ioc property", {
                line,
                content: lines[line - 1],
                key
            });
        values[key] = decode(logical.slice(start), line);
        records.push({ key, start: line - 1, end: Math.min(index, lines.length - 1) });
    }
    return values;
}
module.exports = { parseProperties };
