"use strict";
// Preserve unrelated settings and comments; targeted YAML edits also retain other plugins' exact source text.
const jsonc = require("jsonc-parser");
const toml = require("toml-eslint-parser");
const YAML = require("yaml");
const { isDeepStrictEqual } = require("util");
const { CLIENTS, SERVER_NAME } = require("./mcpClientConfig");

// Older releases wrote this binding into user-level configuration, which sent every project to one window. Merging
// removes it, and the entry reads as outdated until then.
const STALE_BINDING = "EMBERPROBE_WORKSPACE";
const LENIENT_JSON = new Set(["opencode", "cursor"]);

function invalid(format) {
    // Parser messages may contain user configuration (including credentials); never surface them in notifications.
    return new Error(`Invalid or unsupported ${format} MCP configuration`);
}

function assertObject(value, format) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(format);
}

function jsonTree(text, client) {
    const errors = [];
    const tree = jsonc.parseTree(text || "{}", errors, {
        allowTrailingComma: LENIENT_JSON.has(client),
        disallowComments: !LENIENT_JSON.has(client)
    });
    if (errors.length || tree?.type !== "object") throw invalid("JSON");
    const visit = (node) => {
        if (node.type === "object") {
            const keys = node.children.map((property) => property.children[0].value);
            if (new Set(keys).size !== keys.length) throw invalid("JSON");
        }
        for (const child of node.children || []) visit(child);
    };
    visit(tree);
    return tree;
}

function editJson(text, client, snippet) {
    let next = text.trim() ? text : "{}";
    const tree = jsonTree(next, client);
    const group = client === "opencode" ? "mcp" : "mcpServers";
    const servers = jsonc.findNodeAtLocation(tree, [group]);
    if (servers && servers.type !== "object") throw invalid("JSON");
    const location = [group, SERVER_NAME];
    const entry = jsonc.findNodeAtLocation(tree, location);
    if (entry && entry.type !== "object") throw invalid("JSON");
    const desired = JSON.parse(snippet)[group][SERVER_NAME];
    const envKey = client === "opencode" ? "environment" : "env";
    const environment = jsonc.findNodeAtLocation(tree, [...location, envKey]);
    if (environment && environment.type !== "object") throw invalid("JSON");
    const set = (keys, value) => {
        if (value === undefined && !jsonc.findNodeAtLocation(jsonTree(next, client), [...location, ...keys])) return;
        next = jsonc.applyEdits(
            next,
            jsonc.modify(next, [...location, ...keys], value, {
                formattingOptions: { insertSpaces: true, tabSize: 4, eol: text.includes("\r\n") ? "\r\n" : "\n" }
            })
        );
    };
    for (const key of ["url", "httpUrl", "headers", "http_headers"]) set([key], undefined);
    if (client !== "opencode" && jsonc.findNodeAtLocation(tree, [...location, "type"])) set(["type"], "stdio");
    for (const [key, value] of Object.entries(desired)) {
        if (key === envKey) {
            for (const [name, item] of Object.entries(value)) set([envKey, name], item);
        } else set([key], value);
    }
    set([envKey, STALE_BINDING], undefined);
    jsonTree(next, client);
    return next;
}

function removeJson(text, client) {
    if (!text.trim()) return text;
    jsonTree(text, client);
    const next = jsonc.applyEdits(
        text,
        jsonc.modify(text, [client === "opencode" ? "mcp" : "mcpServers", SERVER_NAME], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 4, eol: text.includes("\r\n") ? "\r\n" : "\n" }
        })
    );
    jsonTree(next, client);
    return next;
}

function parseToml(text) {
    try {
        const ast = toml.parseForESLint(text).ast;
        // The parser's static-value helper uses ordinary objects. Refuse prototype keys before invoking it, including
        // keys inside arrays/inline tables; no user-owned configuration may mutate shared JavaScript prototypes.
        toml.traverseNodes(ast, {
            enterNode(node) {
                if (
                    node.type === "TOMLKey" &&
                    keyParts(node).some((key) => ["__proto__", "constructor", "prototype"].includes(key))
                )
                    throw invalid("TOML");
            },
            leaveNode() {}
        });
        return ast;
    } catch {
        throw invalid("TOML");
    }
}

function tomlValue(value) {
    if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
    return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

function keyParts(key) {
    return key.keys.map((part) => (part.type === "TOMLBare" ? part.name : part.value));
}

function startsWith(keys, prefix) {
    return prefix.every((key, index) => key === keys[index]);
}

function tomlAssignments(ast) {
    const assignments = [];
    const tables = [];
    const walk = (body, prefix, parent) => {
        for (const node of body) {
            if (node.type === "TOMLTable") {
                tables.push(node);
                walk(node.body, node.resolvedKey, node);
            } else {
                const keys = [...prefix, ...keyParts(node.key)];
                assignments.push({ node, keys, parent });
                if (node.value.type === "TOMLInlineTable") walk(node.value.body, keys, node.value);
            }
        }
    };
    walk(ast.body[0].body, [], ast.body[0]);
    return { assignments, tables };
}

function setToml(text, keys, value) {
    const { assignments, tables } = tomlAssignments(parseToml(text));
    const exact = assignments.find((entry) => isDeepStrictEqual(entry.keys, keys));
    if (exact) {
        if (value !== undefined) {
            const current = toml.getStaticTOMLValue(exact.node.value);
            if (isDeepStrictEqual(current, value)) return text;
            const [start, end] = exact.node.value.range;
            return text.slice(0, start) + tomlValue(value) + text.slice(end);
        }
        let [start, end] = exact.node.range;
        if (exact.parent.type === "TOMLInlineTable") {
            const index = exact.parent.body.indexOf(exact.node);
            if (index < exact.parent.body.length - 1) end = exact.parent.body[index + 1].range[0];
            else if (index > 0) start = exact.parent.body[index - 1].range[1];
        }
        return text.slice(0, start) + text.slice(end);
    }
    if (value === undefined) return text;
    const ancestor = assignments
        .filter((entry) => startsWith(keys, entry.keys))
        .sort((a, b) => b.keys.length - a.keys.length)[0];
    const suffix = (prefix) => keys.slice(prefix.length).map(tomlValue).join(".");
    if (ancestor) {
        if (ancestor.node.value.type !== "TOMLInlineTable") throw invalid("TOML");
        const node = ancestor.node.value;
        const at = node.range[1] - 1;
        return (
            text.slice(0, at) +
            `${node.body.length ? ", " : ""}${suffix(ancestor.keys)} = ${tomlValue(value)}` +
            text.slice(at)
        );
    }
    const table = tables
        .filter((node) => startsWith(keys, node.resolvedKey))
        .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    if (table) {
        if (table.kind !== "standard") throw invalid("TOML");
        const lineEnd = text.indexOf("\n", table.key.range[1]);
        const at = lineEnd < 0 ? text.length : lineEnd + 1;
        const prefix = lineEnd < 0 ? eol : "";
        return text.slice(0, at) + `${prefix}${suffix(table.resolvedKey)} = ${tomlValue(value)}${eol}` + text.slice(at);
    }
    return `${suffix([])} = ${tomlValue(value)}${eol}${text}`;
}

function editToml(text, snippet) {
    const ast = parseToml(text);
    const config = toml.getStaticTOMLValue(ast);
    if (config.mcp_servers !== undefined) assertObject(config.mcp_servers, "TOML");
    const current = config.mcp_servers?.[SERVER_NAME];
    if (current !== undefined) {
        assertObject(current, "TOML");
        if (current.env !== undefined) assertObject(current.env, "TOML");
    }
    const desired = toml.getStaticTOMLValue(parseToml(snippet)).mcp_servers[SERVER_NAME];
    if (current === undefined) {
        const appended = text + (text && !text.endsWith("\n") ? "\n" : "") + snippet;
        try {
            parseToml(appended);
            return appended;
        } catch {
            // An inline mcp_servers table cannot be reopened; edit its members in place below.
        }
    }
    let next = text;
    const root = ["mcp_servers", SERVER_NAME];
    for (const field of ["url", "type"]) next = setToml(next, [...root, field], undefined);
    for (const [key, value] of Object.entries(desired)) {
        if (key === "env") {
            for (const [name, item] of Object.entries(value)) next = setToml(next, [...root, key, name], item);
        } else next = setToml(next, [...root, key], value);
    }
    next = setToml(next, [...root, "env", STALE_BINDING], undefined);
    parseToml(next);
    return next;
}

function removeToml(text) {
    const root = ["mcp_servers", SERVER_NAME];
    let next = text;
    for (;;) {
        const { assignments, tables } = tomlAssignments(parseToml(next));
        const table = tables.find((node) => startsWith(node.resolvedKey, root));
        if (table) {
            next = next.slice(0, table.range[0]) + next.slice(table.range[1]).replace(/^\r?\n/, "");
            continue;
        }
        const entry = assignments.find((item) => startsWith(item.keys, root));
        if (!entry) return next;
        next = setToml(next, entry.keys, undefined);
    }
}

function yamlTargets(text) {
    const document = YAML.parseDocument(text, { keepSourceTokens: true, logLevel: "silent" });
    if (document.errors.length || (document.contents && !YAML.isSeq(document.contents))) throw invalid("DSH YAML");
    const targets = [];
    const ids = [];
    const inspect = (node) => {
        if (!YAML.isMap(node)) throw invalid("DSH YAML");
        const id = node.get("id");
        if (id) ids.push(id);
        const config = node.get("config", true);
        const matches = YAML.isMap(config) && config.get("serverName") === SERVER_NAME;
        if (id === "mcp-emberprobe" || matches) {
            if (node.get("name") !== "@deepseek-ai/dsh-mcp-client" || !matches) throw invalid("DSH YAML");
            targets.push(node);
        }
        return node;
    };
    const sequence = YAML.isSeq(document.contents) ? document.contents : null;
    for (const node of sequence?.items || []) {
        const map = inspect(node);
        const insert = map.get("insert", true);
        if (insert) {
            if (!YAML.isSeq(insert)) throw invalid("DSH YAML");
            for (const item of insert.items) inspect(item);
        }
    }
    if (targets.length > 1 || ids.filter((id) => id === (targets[0]?.get("id") || "mcp-emberprobe")).length > 1)
        throw invalid("DSH YAML");
    return { document, targets };
}

function editDsh(text, snippet) {
    const { document, targets } = yamlTargets(text);
    const desired = YAML.parse(snippet)[0].insert[0];
    if (targets.length) {
        const node = targets[0];
        // Replacing a tagged/anchored node can change evaluation or strand aliases. Keep it for manual editing.
        YAML.visit(node, (_, value) => {
            if (YAML.isAlias(value) || (YAML.isNode(value) && (value.tag || value.anchor))) throw invalid("DSH YAML");
        });
        const current = node.toJSON();
        assertObject(current.config, "DSH YAML");
        if (current.config.env !== undefined) assertObject(current.config.env, "DSH YAML");
        const config = { ...current.config, ...desired.config, env: { ...current.config.env, ...desired.config.env } };
        for (const key of ["url", "headers"]) delete config[key];
        delete config.env[STALE_BINDING];
        if (!Object.keys(config.env).length) delete config.env;
        const merged = { ...current, config, ...(current.disabled !== undefined ? { disabled: false } : {}) };
        if (isDeepStrictEqual(current, merged)) return text;
        const [start, end] = node.range;
        const eol = text.slice(start, end).endsWith("\n") ? (text.includes("\r\n") ? "\r\n" : "\n") : "";
        const next = text.slice(0, start) + flowJson(merged) + eol + text.slice(end);
        yamlTargets(next);
        return next;
    }
    const seq = YAML.isSeq(document.contents) ? document.contents : null;
    if (seq?.flow && seq.items.length) {
        const at = seq.range[1] - 1;
        const next = text.slice(0, at) + `, ${flowJson({ insert: [desired] })}` + text.slice(at);
        yamlTargets(next);
        return next;
    }
    if (seq && !seq.items.length) return text.slice(0, seq.range[0]) + snippet + text.slice(seq.range[1]);
    return text + (text && !text.endsWith("\n") ? "\n" : "") + snippet;
}

function flowJson(value) {
    return JSON.stringify(value).replace(
        /[\u0085\u2028\u2029]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

// Removes the EmberProbe plugin line by line, so the other plugins keep their exact source text.
function removeDsh(text) {
    const { document, targets } = yamlTargets(text);
    if (!targets.length) return text;
    const [node] = targets;
    YAML.visit(node, (_, value) => {
        if (YAML.isAlias(value) || (YAML.isNode(value) && (value.tag || value.anchor))) throw invalid("DSH YAML");
    });
    // yamlTargets found a target, so the document is a sequence of maps.
    const plugins = /** @type {any} */ (document.contents);
    const outer = plugins.items.find((item) => item === node || item.get("insert", true)?.items.includes(node));
    const insert = outer === node ? null : outer.get("insert", true);
    const onlyPlugin = outer === node || (outer.items.length === 1 && insert.items.length === 1);
    const victim = onlyPlugin ? outer : node;
    const start = text.lastIndexOf("\n", victim.range[0] - 1) + 1;
    if (!/^\s*-\s+$/.test(text.slice(start, victim.range[0]))) throw invalid("DSH YAML");
    const next = text.slice(0, start) + text.slice(victim.range[2]);
    yamlTargets(next);
    return next;
}

function assertAdapter(client) {
    if (!CLIENTS.includes(client) || client === "json")
        throw new Error(`No configuration file adapter for MCP client: ${client}`);
}

function editConfig(client, text, snippet) {
    assertAdapter(client);
    if (client === "codex") return editToml(text, snippet);
    if (client === "dsh") return editDsh(text, snippet);
    return editJson(text, client, snippet);
}

function removeConfig(client, text) {
    assertAdapter(client);
    if (client === "codex") return removeToml(text);
    if (client === "dsh") return removeDsh(text);
    return removeJson(text, client);
}

/** The EmberProbe entry in a client's configuration text, or undefined when there is none. */
function readEntry(client, text) {
    assertAdapter(client);
    if (client === "codex") return toml.getStaticTOMLValue(parseToml(text)).mcp_servers?.[SERVER_NAME];
    if (client === "dsh") return yamlTargets(text).targets[0]?.toJSON();
    const group = client === "opencode" ? "mcp" : "mcpServers";
    const node = jsonc.findNodeAtLocation(jsonTree(text, client), [group, SERVER_NAME]);
    return node && jsonc.getNodeValue(node);
}

module.exports = { editConfig, readEntry, removeConfig, yamlTargets };
