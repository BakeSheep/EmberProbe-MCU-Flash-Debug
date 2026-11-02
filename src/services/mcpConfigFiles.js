"use strict";
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { editConfig, yamlTargets } = require("./mcpConfigEdits");

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const FILE_CLIENTS = Object.freeze(["claude", "codex", "gemini", "opencode", "antigravity", "dsh"]);

async function exists(file, io) {
    try {
        await io.stat(file);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

function absolute(value, fallback) {
    if (!value) return fallback;
    if (!path.isAbsolute(value)) throw new Error("MCP configuration overrides must use absolute paths");
    return value;
}

/** @param {string} client @param {{ home?: string, env?: NodeJS.ProcessEnv, workspace?: string, io?: any }} [options] */
async function configTargets(client, { home = os.homedir(), env = process.env, workspace, io = fs } = {}) {
    if (!FILE_CLIENTS.includes(client)) throw new Error(`No configuration file adapter for MCP client: ${client}`);
    if (client === "dsh") {
        const root = absolute(env.DSH_HOME, path.join(home, ".dsh"));
        const targets = ["web", "desktop"].map((name) => path.join(root, "profiles", name, "cordis.patch.yml"));
        for (const name of ["headless", "acp"]) {
            const file = path.join(root, "profiles", name, "cordis.patch.yml");
            if (await exists(file, io)) targets.push(file);
        }
        return { targets, guard: path.join(root, "cordis.patch.yml") };
    }
    if (client === "claude") {
        const dir = absolute(env.CLAUDE_CONFIG_DIR, path.join(home, ".claude"));
        return { targets: [path.join(dir === path.join(home, ".claude") ? home : dir, ".claude.json")] };
    }
    if (client === "codex")
        return { targets: [path.join(absolute(env.CODEX_HOME, path.join(home, ".codex")), "config.toml")] };
    if (client === "gemini") return { targets: [path.join(home, ".gemini", "settings.json")] };
    if (client === "antigravity") {
        const project = workspace && path.join(workspace, ".agents", "mcp_config.json");
        return {
            targets: [
                project && (await exists(project, io))
                    ? project
                    : path.join(home, ".gemini", "config", "mcp_config.json")
            ]
        };
    }
    if (env.OPENCODE_CONFIG) return { targets: [absolute(env.OPENCODE_CONFIG, "")] };
    const global = path.join(absolute(env.XDG_CONFIG_HOME, path.join(home, ".config")), "opencode");
    // Project configuration can override a global server; update an existing project file first.
    for (const directory of [workspace, global].filter(Boolean)) {
        for (const name of ["opencode.jsonc", "opencode.json"]) {
            const file = path.join(directory, name);
            if (await exists(file, io)) return { targets: [file] };
        }
    }
    return { targets: [path.join(global, "opencode.json")] };
}

async function snapshot(file, io) {
    try {
        const stat = await io.stat(file);
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
            throw new Error("MCP configuration must be a file of at most 2 MiB");
        const previous = await io.readFile(file);
        if (previous.length > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 2 MiB");
        return { previous, mode: stat.mode & 0o777 };
    } catch (error) {
        if (error.code === "ENOENT") return { previous: null, mode: 0o600 };
        throw error;
    }
}

async function canonical(file, io) {
    try {
        return await io.realpath(file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(file);
        if (parent === file) return file;
        return path.join(await canonical(parent, io), path.basename(file));
    }
}

async function prepareClientInstall(client, snippet, options = {}) {
    const io = options.io || fs;
    const { targets, guard } = await configTargets(client, options);
    const files = [];
    const seen = new Set();
    for (const target of targets) {
        const file = await canonical(target, io);
        if (seen.has(file)) {
            files.find((entry) => entry.file === file).sources.push(target);
            continue;
        }
        seen.add(file);
        const original = await snapshot(file, io);
        const text = original.previous?.toString("utf8") || "";
        // Reject invalid UTF-8 rather than replacing bytes in a user-owned configuration file.
        if (original.previous && !Buffer.from(text).equals(original.previous))
            throw new Error("MCP configuration must use UTF-8");
        const bom = text.startsWith("\ufeff") ? "\ufeff" : "";
        const next = Buffer.from(bom + editConfig(client, bom ? text.slice(1) : text, snippet));
        if (next.length > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds 2 MiB");
        files.push({ file, sources: [target], ...original, next });
    }
    const guards = [];
    if (guard) {
        const file = await canonical(guard, io);
        const original = await snapshot(file, io);
        if (original.previous && yamlTargets(original.previous.toString("utf8")).targets.length) {
            throw new Error(
                "DSH home cordis.patch.yml overrides EmberProbe; edit that entry before installing profiles"
            );
        }
        guards.push({ file, sources: [guard], ...original });
    }
    return { client, files, guards };
}

async function assertUnchanged(entry, io) {
    const current = await snapshot(entry.file, io);
    const modeChanged = process.platform !== "win32" && entry.previous !== null && current.mode !== entry.mode;
    if (
        modeChanged ||
        !(entry.previous === null ? current.previous === null : current.previous?.equals(entry.previous))
    ) {
        throw new Error("MCP configuration changed during installation; retry to review the current files");
    }
    // A profile symlink/junction may have changed since the preview. Do not write through a new target.
    for (const source of entry.sources) {
        if ((await canonical(source, io)) !== entry.file)
            throw new Error("MCP configuration path changed during installation");
    }
}

async function stageFile(entry, bytes, io, staged) {
    const temp = entry.file + `.emberprobe-${randomUUID()}.tmp`;
    const handle = await io.open(temp, "wx", entry.mode);
    // Track only files we created. An exclusive-create failure must never delete someone else's file.
    staged.push(temp);
    try {
        await handle.writeFile(bytes);
    } finally {
        await handle.close();
    }
    return temp;
}

async function commitClientInstall(plan, { io = fs } = {}) {
    const changed = plan.files.filter((entry) => !entry.previous?.equals(entry.next));
    const locks = [];
    const staged = [];
    const committed = [];
    let failure;
    try {
        for (const entry of [...changed].sort((a, b) => a.file.localeCompare(b.file))) {
            await assertUnchanged(entry, io);
            await io.mkdir(path.dirname(entry.file), { recursive: true });
            const file = entry.file + (plan.client === "dsh" ? ".lock" : ".emberprobe.lock");
            let handle;
            try {
                handle = await io.open(file, "wx", 0o600);
            } catch (error) {
                if (error.code === "EEXIST")
                    throw new Error("MCP configuration is locked by another writer; retry after it finishes");
                throw error;
            }
            locks.push({ file, handle });
            await handle.writeFile(String(process.pid));
        }
        for (const entry of [...plan.files, ...plan.guards]) await assertUnchanged(entry, io);
        for (const entry of changed) {
            await stageFile(entry, entry.next, io, staged);
        }
        for (let index = 0; index < changed.length; index++) {
            const entry = changed[index];
            for (const guard of plan.guards) await assertUnchanged(guard, io);
            await assertUnchanged(entry, io);
            await io.rename(staged[index], entry.file);
            committed.push(entry);
        }
        for (const guard of plan.guards) await assertUnchanged(guard, io);
    } catch (error) {
        const rollbackErrors = [];
        for (const entry of committed.reverse()) {
            try {
                const current = await snapshot(entry.file, io);
                if (!current.previous?.equals(entry.next))
                    throw new Error("A newer MCP configuration was preserved during rollback");
                for (const source of entry.sources) {
                    if ((await canonical(source, io)) !== entry.file)
                        throw new Error("A newer MCP configuration path was preserved during rollback");
                }
                if (entry.previous === null) await io.unlink(entry.file);
                else {
                    const temp = await stageFile(entry, entry.previous, io, staged);
                    await io.rename(temp, entry.file);
                }
            } catch (failure) {
                rollbackErrors.push(failure);
            }
        }
        failure = rollbackErrors.length
            ? new AggregateError(
                  [error, ...rollbackErrors],
                  "MCP installation failed; rollback could not restore every file"
              )
            : error;
    } finally {
        const failures = [];
        for (const file of staged) {
            try {
                await io.unlink(file);
            } catch (error) {
                if (error.code !== "ENOENT") failures.push(error);
            }
        }
        for (const { file, handle } of locks.reverse()) {
            try {
                await handle.close();
                await io.unlink(file);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length)
            failure = new AggregateError(
                [...(failure ? [failure] : []), ...failures],
                "MCP configuration temporary-file cleanup failed"
            );
    }
    if (failure) throw failure;
    return { files: plan.files.map((entry) => entry.file), changed: changed.length };
}

module.exports = { FILE_CLIENTS, MAX_CONFIG_BYTES, configTargets, prepareClientInstall, commitClientInstall };
