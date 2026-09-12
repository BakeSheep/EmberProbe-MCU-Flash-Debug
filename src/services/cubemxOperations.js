"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { failure } = require("./cubemxEnvironment");

function normalizeProjectPath(root) {
    const resolved = path.resolve(root);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectKey(root) {
    return crypto.createHash("sha256").update(normalizeProjectPath(root)).digest("hex").slice(0, 16);
}

async function atomicWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
}

async function readJson(filePath) {
    try {
        const text = await fs.readFile(filePath, "utf8");
        return JSON.parse(text);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function classifyUserCodeMarkers(text) {
    const beginRegex = /\/\* USER CODE BEGIN ([^*\r\n]+)\*\//g;
    const endRegex = /\/\* USER CODE END ([^*\r\n]+)\*\//g;
    const begins = [];
    const ends = [];
    for (const match of text.matchAll(beginRegex)) {
        begins.push({ name: match[1].trim(), index: match.index, full: match[0] });
    }
    for (const match of text.matchAll(endRegex)) {
        ends.push({ name: match[1].trim(), index: match.index, full: match[0] });
    }
    if (begins.length !== ends.length) {
        return { valid: false, reason: "mismatched_marker_count" };
    }
    const names = new Set();
    const blocks = new Map();
    for (let i = 0; i < begins.length; i++) {
        const b = begins[i];
        const e = ends[i];
        if (b.name !== e.name || b.index > e.index) {
            return { valid: false, reason: "misaligned_marker_pair" };
        }
        if (i > 0 && b.index < ends[i - 1].index) {
            return { valid: false, reason: "nested_markers" };
        }
        if (names.has(b.name)) {
            return { valid: false, reason: "duplicate_marker_name" };
        }
        names.add(b.name);
        const inside = text.slice(b.index + b.full.length, e.index);
        blocks.set(b.name, inside);
    }
    return { valid: true, blocks, names };
}

function classifyUserCodeChanges(oldContent, newContent) {
    const oldMarkers = classifyUserCodeMarkers(oldContent);
    const newMarkers = classifyUserCodeMarkers(newContent);
    if (!oldMarkers.valid || !newMarkers.valid) {
        return { classifiable: false, reason: oldMarkers.reason || newMarkers.reason };
    }
    if (oldMarkers.names.size !== newMarkers.names.size) {
        return { classifiable: false, reason: "marker_set_mismatch" };
    }
    for (const name of oldMarkers.names) {
        if (!newMarkers.names.has(name)) {
            return { classifiable: false, reason: "marker_set_mismatch" };
        }
    }
    const replacePattern = /\/\* USER CODE BEGIN ([^*\r\n]+)\*\/[\s\S]*?\/\* USER CODE END \1\*\//g;
    const oldSkeleton = oldContent.replace(replacePattern, "/* USER CODE: $1 */").replace(/\r\n/g, "\n");
    const newSkeleton = newContent.replace(replacePattern, "/* USER CODE: $1 */").replace(/\r\n/g, "\n");
    const generatedChanged = oldSkeleton !== newSkeleton;
    let userChanged = false;
    for (const [name, oldBlock] of oldMarkers.blocks) {
        const newBlock = newMarkers.blocks.get(name) || "";
        if (oldBlock.replace(/\r\n/g, "\n") !== newBlock.replace(/\r\n/g, "\n")) {
            userChanged = true;
            break;
        }
    }
    return { classifiable: true, generatedChanged, userChanged };
}

function changedUserCodeBlockNames(oldContent, newContent) {
    const oldMarkers = classifyUserCodeMarkers(oldContent);
    const newMarkers = classifyUserCodeMarkers(newContent);
    if (!oldMarkers.valid || !newMarkers.valid) return [];
    const changed = [];
    for (const [name, oldBlock] of oldMarkers.blocks) {
        const newBlock = newMarkers.blocks.get(name);
        if (newBlock === undefined || oldBlock.replace(/\r\n/g, "\n") !== newBlock.replace(/\r\n/g, "\n")) {
            changed.push(name);
        }
    }
    for (const name of newMarkers.blocks.keys()) {
        if (!oldMarkers.blocks.has(name) && !changed.includes(name)) changed.push(name);
    }
    return changed;
}

class CubeMxOperationStore {
    constructor(storageDir) {
        this.baseDir = storageDir ? path.join(storageDir, "cubemx") : path.join(os.tmpdir(), "emberprobe-cubemx-store");
        this.initializedProjects = new Set();
    }

    projectDir(root) {
        return path.join(this.baseDir, "projects", projectKey(root));
    }

    operationsFile(root) {
        return path.join(this.projectDir(root), "operations.json");
    }

    manifestFile(root) {
        return path.join(this.projectDir(root), "manifest.json");
    }

    async ensureProjectInitialized(root) {
        const key = projectKey(root);
        if (this.initializedProjects.has(key)) return;
        const file = this.operationsFile(root);
        // Mark the project initialized only after a successful read: a transient read failure
        // (antivirus locks, EBUSY) must not silently skip interrupt recovery forever.
        const data = await readJson(file);
        this.initializedProjects.add(key);
        if (!data || !Array.isArray(data.operations)) return;
        let modified = false;
        for (const op of data.operations) {
            if (op.status === "in_progress") {
                op.status = "interrupted";
                if (op.stage === "writing" || op.stage === "rollback") {
                    op.sourceProjectStatus = "unknown";
                } else {
                    op.sourceProjectStatus = "unchanged";
                }
                op.updatedAt = new Date().toISOString();
                modified = true;
            }
        }
        if (modified) {
            await atomicWriteJson(file, data);
        }
    }

    async getOperations(root) {
        await this.ensureProjectInitialized(root);
        const data = await readJson(this.operationsFile(root));
        return data?.operations || [];
    }

    async getOperation(root, operationId) {
        const operations = await this.getOperations(root);
        return operations.find((op) => op.operationId === operationId) || null;
    }

    async getLatestOperation(root) {
        const operations = await this.getOperations(root);
        return operations.length ? operations[operations.length - 1] : null;
    }

    async findOperationByRequestId(root, requestId) {
        if (!requestId) return null;
        const operations = await this.getOperations(root);
        return operations.find((op) => op.requestId === requestId) || null;
    }

    async createOperation(root, record) {
        await this.ensureProjectInitialized(root);
        const file = this.operationsFile(root);
        const data = (await readJson(file)) || { operations: [] };
        const operationId = "op_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        const now = new Date().toISOString();
        const operation = {
            operationId,
            projectPath: path.resolve(root),
            createdAt: now,
            updatedAt: now,
            status: "in_progress",
            stage: "init",
            sourceProjectStatus: "unchanged",
            ...record
        };
        data.operations.push(operation);
        if (data.operations.length > 50) {
            data.operations = data.operations.slice(-50);
        }
        await atomicWriteJson(file, data);
        return operation;
    }

    async updateOperation(root, operationId, updates) {
        await this.ensureProjectInitialized(root);
        const file = this.operationsFile(root);
        const data = (await readJson(file)) || { operations: [] };
        const op = data.operations.find((entry) => entry.operationId === operationId);
        if (!op) {
            throw failure("INVALID_ARGUMENT", "Operation not found: " + operationId);
        }
        Object.assign(op, updates, { updatedAt: new Date().toISOString() });
        await atomicWriteJson(file, data);
        return { ...op };
    }

    async saveManifest(root, manifest) {
        const file = this.manifestFile(root);
        await atomicWriteJson(file, manifest);
        return manifest;
    }

    async getManifest(root) {
        return readJson(this.manifestFile(root));
    }
}

module.exports = {
    normalizeProjectPath,
    projectKey,
    atomicWriteJson,
    readJson,
    classifyUserCodeMarkers,
    classifyUserCodeChanges,
    changedUserCodeBlockNames,
    CubeMxOperationStore
};
