"use strict";

const fs = require("fs");
const path = require("path");
const { parseMap, parseLinkerScript, stripComments } = require("../memoryRegions");
const { analyzeMemory, topSymbols } = require("../memoryAnalysis");

class MemoryAnalysisService {
    /** @param {any} options */
    constructor(options) {
        this.elfService = options.elfService;
        this.fs = options.fs || fs;
        this.roots = options.roots || (() => []);
        this.findScripts = options.findScripts || (async () => []);
        this.selection = options.selection || (() => ({}));
        this.regionKinds = options.regionKinds || (() => ({}));
        this.files = new Set();
        this.textCache = new Map();
        this.epoch = 0;
    }

    invalidate() {
        this.epoch++;
        this.textCache.clear();
    }

    filePath(value, elfPath, extension) {
        if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
            throw Object.assign(new Error("Invalid memory layout path"), { code: "INVALID_MEMORY_LAYOUT_PATH" });
        }
        const roots = this.roots();
        const owner = roots.find((root) => this.inside(root, elfPath));
        const resolved = path.resolve(owner || path.dirname(elfPath), value);
        if (path.extname(resolved).toLowerCase() !== extension) {
            throw Object.assign(new Error(`Expected a ${extension} file`), { code: "INVALID_MEMORY_LAYOUT_PATH" });
        }
        if (roots.length && !roots.some((root) => this.inside(root, resolved))) {
            throw Object.assign(new Error("Memory layout must be inside the workspace"), {
                code: "PATH_OUTSIDE_WORKSPACE"
            });
        }
        return resolved;
    }

    inside(root, file) {
        const real = (value) => (this.fs.existsSync(value) ? this.fs.realpathSync(value) : path.resolve(value));
        const relative = path.relative(real(root), real(file));
        return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    }

    readText(file) {
        this.files.add(file);
        const before = this.fs.statSync(file);
        if (before.size > 64 * 1024 * 1024) throw new Error("Memory layout exceeds the 64 MiB limit");
        const previous = this.textCache.get(file);
        if (previous?.mtimeMs === before.mtimeMs && previous.size === before.size) return previous.text;
        const text = this.fs.readFileSync(file, "utf8");
        const after = this.fs.statSync(file);
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
            throw new Error("Layout changed while reading");
        this.textCache.set(file, { text, mtimeMs: after.mtimeMs, size: after.size });
        return text;
    }

    readScript(file, stack = new Set(), visited = new Set()) {
        if (stack.has(file)) throw new Error(`INCLUDE cycle: ${file}`);
        if (stack.size >= 16 || visited.size >= 64) throw new Error("Too many linker INCLUDE files");
        if (visited.has(file)) return "";
        visited.add(file);
        stack.add(file);
        try {
            const text = stripComments(this.readText(file));
            return text.replace(/\bINCLUDE\s+(?:"([^"\r\n]+)"|([^\s;]+))\s*;?/g, (_match, quoted, plain) => {
                const include = path.resolve(path.dirname(file), quoted || plain);
                const roots = this.roots();
                if (roots.length && !roots.some((root) => this.inside(root, include)))
                    throw new Error("INCLUDE is outside the workspace");
                return this.readScript(include, stack, visited);
            });
        } finally {
            stack.delete(file);
        }
    }

    async analyze(params = {}) {
        const epoch = this.epoch;
        const snapshot = await this.elfService.load();
        if (!snapshot.memory)
            throw Object.assign(new Error("ELF section metadata unavailable"), { code: "ELF_METADATA_UNAVAILABLE" });
        const selected = this.selection(snapshot.elf.path) || {};
        const diagnostics = [];
        this.files = new Set([snapshot.elf.path]);
        const source = { kind: "elf", mapFile: null, linkerScript: null, files: [], candidates: [] };
        let definitions = [];
        const warn = (code, message) => diagnostics.push({ code, message });
        let maps = [];
        const requestedMap = params.mapFile ?? selected.mapFile;
        if (requestedMap) maps = [this.filePath(requestedMap, snapshot.elf.path, ".map")];
        else {
            maps = [snapshot.elf.path.replace(/\.elf$/i, ".map"), snapshot.elf.path + ".map"];
            for (const file of maps) this.files.add(file);
            maps = [...new Set(maps)].filter((file) => this.fs.existsSync(file));
        }
        if (maps.length > 1) {
            source.candidates.push(...maps);
            warn("MEMORY_SOURCE_AMBIGUOUS", "Choose between the matching .map files");
        } else if (maps.length === 1) {
            try {
                const parsed = parseMap(this.readText(maps[0]), snapshot.memory.sections);
                diagnostics.push(...parsed.diagnostics);
                if (parsed.regions.length) {
                    definitions = parsed.regions;
                    source.kind = "map";
                    source.mapFile = maps[0];
                }
            } catch (error) {
                warn("MEMORY_SOURCE_READ_FAILED", `${maps[0]}: ${error.message}`);
            }
        }
        if (!definitions.length && maps.length <= 1) {
            const requestedScript = params.linkerScript ?? selected.linkerScript;
            let scripts;
            if (requestedScript) scripts = [this.filePath(requestedScript, snapshot.elf.path, ".ld")];
            else {
                const root = this.roots().find((item) => this.inside(item, snapshot.elf.path));
                scripts = [...new Set(await this.findScripts(root))];
            }
            if (scripts.length > 1) {
                source.candidates.push(...scripts);
                warn("MEMORY_SOURCE_AMBIGUOUS", "Choose the linker script used by this ELF");
            } else if (scripts.length === 1) {
                try {
                    const parsed = parseLinkerScript(this.readScript(scripts[0]));
                    diagnostics.push(...parsed.diagnostics);
                    definitions = parsed.regions;
                    source.kind = definitions.length ? "linker-script" : "elf";
                    source.linkerScript = scripts[0];
                } catch (error) {
                    warn("MEMORY_SOURCE_READ_FAILED", `${scripts[0]}: ${error.message}`);
                }
            }
        }
        const kinds = this.regionKinds();
        if (
            !kinds ||
            typeof kinds !== "object" ||
            Array.isArray(kinds) ||
            Object.values(kinds).some((kind) => !["flash", "ram", "other"].includes(kind))
        ) {
            throw Object.assign(new Error("Invalid memory.regionKinds"), { code: "INVALID_MEMORY_REGION_KINDS" });
        }
        if (epoch !== this.epoch)
            throw Object.assign(new Error("Memory analysis changed"), { code: "MEMORY_ANALYSIS_CHANGED" });
        source.files = [...this.files];
        return {
            ...analyzeMemory(snapshot, definitions, kinds, diagnostics),
            source,
            topSymbols: topSymbols(snapshot, params.top)
        };
    }
}

module.exports = { MemoryAnalysisService };
