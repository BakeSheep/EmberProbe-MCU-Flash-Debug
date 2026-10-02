"use strict";

const diagnostic = (code, message) => ({ code, message });
const LIMIT = 0x100000000;

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, "");
}

// Parse integers without evaluating JavaScript or executing linker commands.
/** @param {string} expression @param {(name: string) => number} [lookup] */
function evaluate(
    expression,
    lookup = (name) => {
        throw new Error(`Unknown constant: ${name}`);
    }
) {
    const tokens = [];
    const pattern = /\s*(0[xX][\da-fA-F]+|\d+[kKmM]?|[A-Za-z_$][\w$]*|<<|>>|[()+\-*/%~&|^,])/y;
    let offset = 0;
    while (offset < expression.trimEnd().length) {
        pattern.lastIndex = offset;
        const match = pattern.exec(expression);
        if (!match) throw new Error(`Unsupported expression: ${expression}`);
        tokens.push(match[1]);
        offset = pattern.lastIndex;
        if (tokens.length > 256) throw new Error("Expression is too complex");
    }
    let at = 0;
    const precedence = { "|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
    const consume = (token) => {
        if (tokens[at++] !== token) throw new Error(`Expected ${token} in ${expression}`);
    };
    const primary = () => {
        const token = tokens[at++];
        if (token === "(") {
            const value = binary(1);
            consume(")");
            return value;
        }
        if (["+", "-", "~"].includes(token)) {
            const value = primary();
            return token === "-" ? -value : token === "~" ? ~value : value;
        }
        if (/^(?:0[xX][\da-fA-F]+|\d+[kKmM]?)$/.test(token || "")) {
            const suffix = token.match(/[kKmM]$/)?.[0];
            return BigInt(suffix ? token.slice(0, -1) : token) * (suffix ? (/k/i.test(suffix) ? 1024n : 1048576n) : 1n);
        }
        if (/^[A-Za-z_$][\w$]*$/.test(token || "")) {
            if (["ORIGIN", "LENGTH"].includes(token) && tokens[at] === "(") {
                consume("(");
                const name = tokens[at++];
                consume(")");
                return BigInt(lookup(`${token}:${name}`));
            }
            return BigInt(lookup(token));
        }
        throw new Error(`Invalid expression: ${expression}`);
    };
    const binary = (minimum) => {
        let value = primary();
        while ((precedence[tokens[at]] || 0) >= minimum) {
            const op = tokens[at++];
            const right = binary(precedence[op] + 1);
            if (["<<", ">>"].includes(op) && (right < 0n || right > 63n)) throw new Error("Invalid shift");
            switch (op) {
                case "+":
                    value += right;
                    break;
                case "-":
                    value -= right;
                    break;
                case "*":
                    value *= right;
                    break;
                case "/":
                    value /= right;
                    break;
                case "%":
                    value %= right;
                    break;
                case "<<":
                    value <<= right;
                    break;
                case ">>":
                    value >>= right;
                    break;
                case "&":
                    value &= right;
                    break;
                case "|":
                    value |= right;
                    break;
                case "^":
                    value ^= right;
                    break;
            }
            if (value > 1n << 64n || value < -(1n << 64n)) throw new Error("Expression overflow");
        }
        return value;
    };
    const value = binary(1);
    if (at !== tokens.length || value < 0n || value > BigInt(LIMIT))
        throw new Error(`Invalid address or size: ${expression}`);
    return Number(value);
}

function validRegion(region) {
    return (
        Number.isSafeInteger(region.origin) &&
        region.origin >= 0 &&
        region.origin < LIMIT &&
        Number.isSafeInteger(region.capacity) &&
        region.capacity > 0 &&
        region.origin + region.capacity <= LIMIT
    );
}

function parseLinkerScript(text) {
    const clean = stripComments(text);
    const expressions = new Map();
    const definitions = [];
    const diagnostics = [];
    const aliases = new Map();
    const seen = new Set();
    for (const match of clean.matchAll(/\bREGION_ALIAS\s*\(\s*"([^"\r\n]+)"\s*,\s*([\w$]+)\s*\)\s*;?/g)) {
        aliases.set(match[1], match[2]);
    }
    for (const match of clean.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([^;{}]+);/g)) {
        expressions.set(match[1], match[2].trim());
    }
    for (const block of clean.matchAll(/\bMEMORY\s*\{([^{}]*)\}/g)) {
        const entries =
            /([A-Za-z_$][\w$.-]*)\s*(?:\([^)]*\))?\s*:\s*(?:ORIGIN|org|o)\s*=\s*([^,]+),\s*(?:LENGTH|len|l)\s*=\s*([\s\S]*?)(?=\s+[A-Za-z_$][\w$.-]*\s*(?:\([^)]*\))?\s*:|$)/g;
        let count = 0;
        for (const entry of block[1].matchAll(entries)) {
            count++;
            const name = entry[1];
            if (seen.has(name)) {
                diagnostics.push(diagnostic("REGION_DUPLICATE", `Duplicate region: ${name}`));
                continue;
            }
            seen.add(name);
            expressions.set(`ORIGIN:${name}`, entry[2].trim());
            expressions.set(`LENGTH:${name}`, entry[3].trim().replace(/;$/, ""));
            definitions.push(name);
        }
        if (!count || block[1].replace(entries, "").replace(/[\s;]/g, "")) {
            diagnostics.push(diagnostic("LINKER_SYNTAX_UNSUPPORTED", "Cannot parse all MEMORY definitions"));
        }
    }
    const values = new Map();
    const resolving = new Set();
    const resolve = (name) => {
        const colon = name.indexOf(":");
        if (colon >= 0) {
            let region = name.slice(colon + 1);
            const visited = new Set();
            while (aliases.has(region)) {
                if (visited.has(region)) throw new Error(`Alias cycle: ${region}`);
                visited.add(region);
                region = aliases.get(region);
            }
            name = name.slice(0, colon + 1) + region;
        }
        if (values.has(name)) return values.get(name);
        if (resolving.has(name) || resolving.size > 64) throw new Error(`Constant cycle: ${name}`);
        if (!expressions.has(name)) throw new Error(`Unknown constant: ${name}`);
        resolving.add(name);
        try {
            const value = evaluate(expressions.get(name), resolve);
            values.set(name, value);
            return value;
        } finally {
            resolving.delete(name);
        }
    };
    const regions = [];
    for (const name of definitions) {
        try {
            const region = { name, origin: resolve(`ORIGIN:${name}`), capacity: resolve(`LENGTH:${name}`) };
            if (!validRegion(region)) throw new Error(`Invalid region range: ${name}`);
            regions.push(region);
        } catch (error) {
            diagnostics.push(diagnostic("LINKER_EXPRESSION_UNRESOLVED", `${name}: ${error.message}`));
        }
    }
    if (!definitions.length) diagnostics.push(diagnostic("MEMORY_REGIONS_MISSING", "No MEMORY definitions found"));
    return { regions, diagnostics };
}

function parseMap(text, sections) {
    const diagnostics = [];
    const regions = [];
    const block = text.match(/Memory Configuration\s*\r?\n([\s\S]*?)(?=Linker script and memory map|$)/);
    if (block) {
        for (const line of block[1].split(/\r?\n/)) {
            const match = line.match(/^\s*(\S+)\s+(0x[\da-f]+)\s+(0x[\da-f]+)(?:\s|$)/i);
            if (!match || match[1] === "*default*") continue;
            const region = { name: match[1], origin: Number(match[2]), capacity: Number(match[3]) };
            if (!validRegion(region) || regions.some((item) => item.name === region.name)) {
                diagnostics.push(diagnostic("MAP_REGION_INVALID", `Invalid or duplicate region: ${region.name}`));
            } else regions.push(region);
        }
    }
    const outputs = [];
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes("Linker script and memory map"));
    for (let i = start < 0 ? lines.length : start + 1; i < lines.length; i++) {
        const line = lines[i];
        let match = line.match(/^(\S+)\s+(0x[\da-f]+)\s+(0x[\da-f]+)(?:\s|$)/i);
        if (!match && /^\S+\s*$/.test(line)) {
            const next = lines[i + 1]?.match(/^\s+(0x[\da-f]+)\s+(0x[\da-f]+)(?:\s|$)/i);
            if (next) match = [line + lines[i + 1], line.trim(), next[1], next[2]];
        }
        if (match) outputs.push({ name: match[1], addr: Number(match[2]), size: Number(match[3]) });
    }
    const alloc = sections.filter((section) => section.flags & 2 && section.size);
    const expected = new Set(alloc.map((s) => `${s.name}:${s.addr}:${s.size}`));
    const actual = new Set(outputs.filter((s) => s.size).map((s) => `${s.name}:${s.addr}:${s.size}`));
    if (
        !alloc.length ||
        [...expected].some((key) => !actual.has(key)) ||
        outputs.some(
            (s) =>
                alloc.some((item) => item.name === s.name) && s.size && !expected.has(`${s.name}:${s.addr}:${s.size}`)
        )
    ) {
        diagnostics.push(
            diagnostic("MAP_ELF_MISMATCH", "Map sections do not match the selected ELF; rebuild the project")
        );
    }
    if (!regions.length) diagnostics.push(diagnostic("MEMORY_REGIONS_MISSING", "No map MEMORY regions found"));
    return { regions: diagnostics.length ? [] : regions, diagnostics };
}

module.exports = { evaluate, stripComments, parseLinkerScript, parseMap, validRegion };
