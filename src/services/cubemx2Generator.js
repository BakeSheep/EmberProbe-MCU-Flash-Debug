"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { failure, supportedPlatform } = require("./cubemxEnvironment");
const { installation, applicationBundle } = require("./cubemx2Environment");
const { hash, snapshot, assertOutsideLinks, fileDiff, materialize } = require("./cubemxProject");
const { atomicWriteJson } = require("./cubemxOperations");
const project2 = require("./cubemx2Project");
const { operationList } = require("./cubemx2Commands");
const { startBackend, removeWorkingArea } = require("./cubemx2Backend");

const GENERATION_TIMEOUT_MS = 600000;
const COMMAND_TIMEOUT_MS = 120000;
const MAX_RESULT_CHARS = 256 * 1024;
const PACK_SOURCE = "include-packs-from-local";
const DEEP_GUARANTEE =
    "Deep check proves regenerability consistency under current tools. Does not verify build or hardware behavior.";
const QUICK_GUARANTEE =
    "Quick check proves changes relative to the recorded manifest only. Does not verify build or hardware behavior.";

const isIoc2 = (file) => typeof file === "string" && path.extname(file).toLowerCase() === ".ioc2";
const slash = (file) => file.split(path.sep).join("/");

// CubeMX2 (.ioc2) projects: CubeMxService keeps operation records, confirmation and writeback, and
// delegates reading, candidate creation, generation and checks here.
class CubeMx2Generator {
    constructor(service) {
        this.service = service;
        this.options = service.options.cubemx2 || {};
        /** @type {Promise<unknown>} */
        this.queue = Promise.resolve();
    }

    /**
     * One CubeMX2 backend at a time: preparation, queries and generation each start their own.
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    _exclusive(task) {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => {});
        return run;
    }

    async _tool(config, version) {
        const platform = this.service.options.platform || process.platform;
        if (!supportedPlatform(platform))
            throw failure("CUBEMX2_PLATFORM_UNSUPPORTED", "CubeMX2 generation supports Windows and Linux");
        if (!config.cubemx2Path)
            throw failure("CUBEMX2_MISSING", "CubeMX2 not found; configure emberprobe.cubemx2Path in User settings");
        const tool = await (this.options.installation || installation)(config.cubemx2Path, { platform });
        const bundle = await (this.options.applicationBundle || applicationBundle)(tool, version, { platform });
        return {
            tool: { executable: tool.executable, version: bundle.version, launcherVersion: tool.version },
            bundle
        };
    }

    async _read(ioc) {
        const stat = await fs.stat(ioc);
        if (stat.size > project2.MAX_IOC2_BYTES)
            throw failure("CUBEMX2_PROJECT_INVALID", ".ioc2 exceeds 8 MiB", { file: ioc });
        return fs.readFile(ioc, "utf8");
    }

    // The selected project with its parsed content and the CubeMX2 bundle that matches it.
    async project() {
        const { workspace, root, ioc, config } = await this.service._resolveProjectRoot();
        const content = await this._read(ioc);
        const parsed = project2.parseIoc2(content);
        const summary = project2.summarize(parsed, ioc);
        const { tool, bundle } = await this._tool(config, summary.cubemx2Version);
        return { workspace, root, ioc, tool, generator: "cubemx2", bundle, content, parsed, summary };
    }

    async inspect(params = {}) {
        const { workspace, root, ioc, tool, generator, content, parsed, summary } = await this.project();
        const base = { workspace, root, ioc, tool, generator };
        const prefix = params.prefix === undefined ? undefined : String(params.prefix);
        const files =
            prefix === undefined
                ? undefined
                : Object.fromEntries([...parsed.files].filter(([file]) => file.startsWith(prefix)));
        if (params.full) return { ...base, summary, content, internalFiles: [...parsed.files.keys()] };
        return { ...base, summary, ...(files ? { values: files } : {}), full: false };
    }

    async _candidate(root, candidateHash) {
        if (typeof candidateHash !== "string" || !/^[0-9a-f]{64}$/.test(candidateHash))
            throw failure("INVALID_ARGUMENT", "candidateHash must be the SHA-256 returned by cubemx.prepare");
        const file = path.join(this.service.store.projectDir(root), "candidates", candidateHash + ".ioc2");
        const content = await fs.readFile(file, "utf8").catch(() => null);
        if (content === null || hash(content) !== candidateHash)
            throw failure("CUBEMX_PROJECT_CHANGED", "Prepared CubeMX2 candidate is missing; prepare again", {
                candidateHash
            });
        return content;
    }

    async plan(params = {}) {
        rejectContent(params);
        const project = await this.project();
        const content = params.candidateHash
            ? await this._candidate(project.root, params.candidateHash)
            : project.content;
        const candidate = project2.parseIoc2(content);
        const after = project2.summarize(candidate, project.ioc);
        for (const key of ["chip", "cubemx2Version", "projectName"])
            if (after[key] !== project.summary[key])
                throw failure(
                    "CUBEMX_LAYOUT_UNSUPPORTED",
                    "Changing chip, project name or CubeMX2 version is unsupported",
                    {
                        key
                    }
                );
        if (candidate.description.workingAreaId !== project.parsed.description.workingAreaId)
            throw failure("CUBEMX_PROJECT_CHANGED", "Candidate belongs to another project; prepare again");
        if (project.summary.outputPath) {
            const output = path.resolve(project.root, project.summary.outputPath);
            const real = await fs.realpath(output).catch(() => output);
            if (path.relative(project.root, real) !== "")
                throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Generation output must be the .ioc2 directory", {
                    expectedRoot: project.root,
                    candidateDirectory: output,
                    condition: "output_path"
                });
        }
        const trust = {
            generator: "cubemx2",
            workspace: project.workspace,
            ioc: project.ioc,
            chip: project.summary.chip,
            tool: project.tool,
            output: project.root
        };
        const changes = project2.changes(project.parsed, candidate);
        return {
            ...project,
            candidate: content,
            values: {},
            identity: { ...trust, before: hash(project.content), after: hash(content) },
            trust,
            changes,
            categorizedChanges: project2.categorize(changes)
        };
    }

    // Stage a copy of a project under a fresh working area so CubeMX2 never touches the user's own one.
    async _stageProject(directory, name, content) {
        await fs.mkdir(directory, { recursive: true });
        const workingAreaId = project2.newWorkingAreaId();
        const file = path.join(directory, name);
        await fs.writeFile(file, project2.withWorkingArea(content, workingAreaId));
        return { file, workingAreaId };
    }

    // Run fn with an owned backend; the backend and the staged working areas are always cleaned up.
    /**
     * @template T
     * @param {(backend: any, open: (staged: { file: string, workingAreaId: string }) => Promise<any>) => Promise<T>} fn
     * @returns {Promise<{ result: T, exitConfirmed: boolean }>}
     */
    async _withBackend(bundle, stage, logPath, signal, fn) {
        const areas = [];
        const backend = await (this.options.startBackend || startBackend)(bundle, {
            userDataDir: path.join(stage, "backend-user-data"),
            logPath,
            signal,
            platform: this.service.options.platform
        });
        const open = async (staged) => {
            const projects = await backend.run(["project", "get-sw-project-list"], {
                project: staged.file,
                timeoutMs: COMMAND_TIMEOUT_MS,
                signal
            });
            const reported = Array.isArray(projects) ? projects.find((item) => typeof item?.path === "string") : null;
            if (reported) areas.push([reported.path, staged.workingAreaId]);
            return projects;
        };
        let result;
        let exitConfirmed = false;
        try {
            result = await fn(backend, open);
        } finally {
            exitConfirmed = await backend.close().catch(() => false);
            // A backend that may still run keeps its working areas; they are removed only after a confirmed exit.
            if (exitConfirmed)
                for (const [reported, id] of areas) await removeWorkingArea(reported, id).catch(() => false);
        }
        return { result, exitConfirmed };
    }

    async prepare(params = {}) {
        rejectContent(params);
        let candidateHash = params.candidateHash;
        let operationResults;
        let clockStatus;
        if (params.operations !== undefined) {
            if (params.candidateHash !== undefined)
                throw failure("INVALID_ARGUMENT", "Provide operations or candidateHash, not both");
            const operations = operationList(params.operations, { mutating: true });
            const project = await this.project();
            const prepared = await this._exclusive(() => this._applyOperations(project, operations));
            candidateHash = hash(prepared.content);
            operationResults = prepared.results;
            clockStatus = prepared.clockStatus;
            const directory = path.join(this.service.store.projectDir(project.root), "candidates");
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, candidateHash + ".ioc2"), prepared.content);
            await this._pruneCandidates(directory);
        }
        const plan = await this.plan(candidateHash ? { candidateHash } : {});
        const request = this.service.authorization.request(plan);
        const auth = request.question
            ? {
                  ...request,
                  question: "Allow this .ioc2 change and CubeMX2 generation once, or for this project for 24 hours?"
              }
            : request;
        const verification = {
            projectSyntax: "passed",
            operations: operationResults ? "applied" : "none",
            generation: "notRun",
            writeback: "notRun",
            build: "notRun",
            hardware: "notRun"
        };
        const common = {
            generator: "cubemx2",
            ioc: plan.ioc,
            output: plan.root,
            tool: plan.tool,
            ...(candidateHash ? { candidateHash } : {}),
            ...(operationResults ? { operationResults } : {}),
            ...(clockStatus !== undefined ? { clockStatus } : {}),
            verification
        };
        if (params.full || !params.summary)
            return { ...common, changes: plan.changes, categorizedChanges: plan.categorizedChanges, ...auth };
        const diffsDir = path.join(this.service.store.projectDir(plan.root), "diffs");
        await fs.mkdir(diffsDir, { recursive: true });
        const diffPath = path.join(
            diffsDir,
            `diff-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.json`
        );
        await atomicWriteJson(diffPath, {
            ioc: plan.ioc,
            changes: plan.changes,
            categorizedChanges: plan.categorizedChanges
        });
        const shown = plan.changes.slice(0, 20);
        return {
            ...common,
            changes: shown,
            changesSummary: {
                total: plan.changes.length,
                shown: shown.length,
                truncated: plan.changes.length > shown.length,
                diffPath,
                byCategory: Object.fromEntries(
                    Object.entries(plan.categorizedChanges).map(([name, list]) => [name, list.length])
                )
            },
            ...auth
        };
    }

    async _pruneCandidates(directory) {
        const entries = await fs.readdir(directory).catch(() => []);
        if (entries.length <= 20) return;
        const stats = await Promise.all(
            entries.map(async (name) => ({
                name,
                time: (await fs.stat(path.join(directory, name)).catch(() => null))?.mtimeMs || 0
            }))
        );
        stats.sort((a, b) => b.time - a.time);
        for (const entry of stats.slice(20))
            await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => {});
    }

    async _applyOperations(project, operations) {
        const stage = await this.service._createStage("prep2");
        try {
            const staged = await this._stageProject(
                path.join(stage, "project"),
                path.basename(project.ioc),
                project.content
            );
            const { result } = await this._withBackend(
                project.bundle,
                stage,
                path.join(stage, "prepare.log"),
                undefined,
                async (backend, open) => {
                    await open(staged);
                    const results = [];
                    for (const operation of operations) {
                        const data = await backend.run(operation.argv, {
                            project: staged.file,
                            timeoutMs: COMMAND_TIMEOUT_MS
                        });
                        results.push({
                            command: operation.command,
                            ...(data !== undefined ? { data: limit(data) } : {})
                        });
                    }
                    await backend.run(["project", "save"], { project: staged.file, timeoutMs: COMMAND_TIMEOUT_MS });
                    const clockStatus = await backend
                        .run(["clock", "get-clock-status"], { project: staged.file, timeoutMs: COMMAND_TIMEOUT_MS })
                        .catch((error) => ({ error: error.message }));
                    return { results, clockStatus };
                }
            );
            const saved = await this._read(staged.file);
            const content = project2.withWorkingArea(saved, project.parsed.description.workingAreaId);
            project2.parseIoc2(content);
            return { ...result, content };
        } finally {
            await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        }
    }

    // Read-only CubeMX2 commands against a staged copy of the selected project.
    async query(params = {}) {
        const list =
            params.operations !== undefined ? params.operations : [{ command: params.command, args: params.args }];
        const operations = operationList(list, { mutating: false });
        const project = await this.project();
        return this._exclusive(async () => {
            const stage = await this.service._createStage("query2");
            try {
                const staged = await this._stageProject(
                    path.join(stage, "project"),
                    path.basename(project.ioc),
                    project.content
                );
                const { result } = await this._withBackend(
                    project.bundle,
                    stage,
                    path.join(stage, "query.log"),
                    undefined,
                    async (backend, open) => {
                        await open(staged);
                        const results = [];
                        for (const operation of operations) {
                            try {
                                const data = await backend.run(operation.argv, {
                                    project: staged.file,
                                    timeoutMs: COMMAND_TIMEOUT_MS
                                });
                                results.push({ command: operation.command, ok: true, data: limit(data) });
                            } catch (error) {
                                results.push({
                                    command: operation.command,
                                    ok: false,
                                    error: { code: error.code, message: error.message }
                                });
                            }
                        }
                        return results;
                    }
                );
                return { generator: "cubemx2", ioc: project.ioc, results: result };
            } finally {
                await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
            }
        });
    }

    async permission(summary) {
        const { workspace, root, ioc, config } = await this.service._resolveProjectRoot();
        const parsed = project2.parseIoc2(await this._read(ioc));
        const info = project2.summarize(parsed, ioc);
        if (!info.chip) throw new Error("Chip identity is unavailable");
        const { tool } = await this._tool(config, info.cubemx2Version);
        const trust = { generator: "cubemx2", workspace, ioc, chip: info.chip, tool, output: root };
        return { ...summary, ...this.service.authorization.status(trust), applicability: "verified" };
    }

    async _exportTarget(backend, file, summary) {
        const format = summary.format || "CMake";
        const toolchain = summary.toolchain || (format === "EWARM" ? "IAR" : "GCC");
        const profile = (summary.buildProfile || "Debug").toLowerCase();
        const targets = await backend.run(["ide-project", "build-target", "list"], {
            project: file,
            timeoutMs: COMMAND_TIMEOUT_MS
        });
        const list = Array.isArray(targets) ? targets.filter((item) => typeof item === "string") : [];
        const target =
            list.find((item) => item.toLowerCase().startsWith(`.${profile}_${toolchain.toLowerCase()}+`)) ||
            list.find((item) => /^\.debug_gcc\+/i.test(item));
        if (!target)
            throw failure("CUBEMX2_BUILD_TARGET_MISSING", "No CubeMX2 build target matches the project toolchain", {
                format,
                toolchain,
                targets: list
            });
        return { format, target };
    }

    // Generate one staged project into an empty directory and return its files with their CubeMX2 groups.
    async _generate(backend, open, staged, output, summary, signal, started) {
        await open(staged);
        const { format, target } = await this._exportTarget(backend, staged.file, summary);
        const remaining = GENERATION_TIMEOUT_MS - (Date.now() - started);
        if (remaining <= 0) throw failure("CUBEMX_TIMEOUT", "Generation exceeded ten minutes");
        await fs.mkdir(output, { recursive: true });
        await backend.run(
            [
                "ide-project",
                "generate",
                `--format=${format}`,
                `--build-target=${target}`,
                `--destination=${output}`,
                `--source=${PACK_SOURCE}`
            ],
            { project: staged.file, timeoutMs: remaining, signal }
        );
        const files = await snapshot(output);
        const exported = files.get(path.join(...project2.EXPORTED_FILES.split("/")));
        if (!exported)
            throw failure("CUBEMX2_OUTPUT_INVALID", "Generation did not record .settings/exported-files.json");
        const groups = project2.exportedGroups(exported.bytes);
        for (const file of groups.keys())
            if (!files.has(path.join(...file.split("/"))))
                throw failure("CUBEMX2_OUTPUT_INVALID", "A recorded generated file is missing", { file });
        const group = (file) => groups.get(slash(file)) || "generated";
        return { files, group, format, target };
    }

    async produce(plan, params, op, controller, progress, context) {
        const service = this.service;
        const runDir = service._runDir(plan.root, op.operationId);
        const links = [];
        const before = await snapshot(plan.root, { links });
        const name = path.basename(plan.ioc);
        if (before.get(name)?.hash !== plan.identity.before)
            throw failure("CUBEMX_PROJECT_CHANGED", ".ioc2 changed after confirmation");
        context.stage = await service._createStage("gen2");
        await fs.mkdir(runDir, { recursive: true });
        await service.store.updateOperation(plan.root, op.operationId, {
            stagePath: context.stage,
            diagnosticsPath: runDir
        });
        const logPath = path.join(runDir, "cubemx2.log");
        context.currentRun = { directory: context.stage, logPath };
        await service.store.updateOperation(plan.root, op.operationId, { logPath });
        const started = Date.now();
        const stage = context.stage;
        const { result, exitConfirmed } = await this._exclusive(() =>
            this._withBackend(plan.bundle, stage, logPath, controller.signal, async (backend, open) => {
                progress?.("baseline");
                await service.store.updateOperation(plan.root, op.operationId, {
                    stage: "baseline",
                    sourceProjectStatus: "unchanged"
                });
                const baseStaged = await this._stageProject(path.join(stage, "baseline-project"), name, plan.content);
                const base = await this._generate(
                    backend,
                    open,
                    baseStaged,
                    path.join(stage, "baseline"),
                    plan.summary,
                    controller.signal,
                    started
                );
                const drift = [...base.files.keys()]
                    .filter((file) => !project2.USER_GROUPS.has(base.group(file)) && before.has(file))
                    .filter((file) => !project2.sameContent(slash(file), before.get(file), base.files.get(file)))
                    .sort()
                    .map((file) => ({ file, action: "modified" }));
                if (drift.length) {
                    const baselineOutput = path.join(runDir, "baseline-drift");
                    await materialize(
                        baselineOutput,
                        new Map(drift.map((entry) => [entry.file, base.files.get(entry.file)]))
                    );
                    throw failure(
                        "CUBEMX_BASELINE_DRIFT",
                        "Existing CubeMX2-owned files cannot be reproduced; review hand edits before generating",
                        { changes: drift, baselineOutput }
                    );
                }
                if (controller.signal.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
                progress?.("generating");
                await service.store.updateOperation(plan.root, op.operationId, {
                    stage: "generating",
                    sourceProjectStatus: "unchanged"
                });
                const candidateStaged = await this._stageProject(
                    path.join(stage, "candidate-project"),
                    name,
                    plan.candidate
                );
                const next = await this._generate(
                    backend,
                    open,
                    candidateStaged,
                    path.join(stage, "candidate"),
                    project2.summarize(project2.parseIoc2(plan.candidate), plan.ioc),
                    controller.signal,
                    started
                );
                return { base, next };
            })
        );
        const { base, next } = result;
        const after = new Map(before);
        const owned = new Set();
        const userFiles = [];
        for (const [file, entry] of next.files) {
            if (project2.USER_GROUPS.has(next.group(file))) {
                if (!before.has(file)) after.set(file, entry);
                else if (before.get(file).hash !== entry.hash) userFiles.push(slash(file));
                continue;
            }
            owned.add(file);
            if (!project2.sameContent(slash(file), before.get(file), entry)) after.set(file, entry);
        }
        // Files CubeMX2 generated for the old configuration but no longer generates (for example a disabled
        // peripheral's init file) are removed; the drift check proved they are unchanged.
        for (const file of base.files.keys())
            if (!next.files.has(file) && !project2.USER_GROUPS.has(base.group(file)) && before.has(file))
                after.delete(file);
        after.set(name, { bytes: Buffer.from(plan.candidate), hash: hash(plan.candidate) });
        assertOutsideLinks(links, new Map(fileDiff(before, after).map((item) => [item.file, true])));
        return {
            before,
            after,
            warnings: [
                ...(exitConfirmed ? [] : ["CUBEMX2_EXIT_UNCONFIRMED: the CubeMX2 backend did not confirm its exit"]),
                ...(userFiles.length
                    ? [
                          `User-owned files kept unchanged: ${userFiles.slice(0, 10).join(", ")}${userFiles.length > 10 ? ", ..." : ""}`
                      ]
                    : [])
            ],
            manifest: () => ({
                generator: "cubemx2",
                ioc2Files: Object.fromEntries(
                    [...project2.parseIoc2(plan.candidate).files].map(([file, text]) => [file, hash(text)])
                ),
                generation: { format: next.format, buildTarget: next.target },
                files: Object.fromEntries(
                    [...owned].filter((file) => after.has(file)).map((file) => [file, { hash: after.get(file).hash }])
                )
            })
        };
    }

    async quickCheck(project, manifest) {
        const content = await this._read(project.ioc);
        const iocChanged = hash(content) !== manifest.iocHash;
        const configChanges = [];
        if (iocChanged) {
            const current = project2.parseIoc2(content);
            const recorded = manifest.ioc2Files || {};
            for (const file of [...new Set([...Object.keys(recorded), ...current.files.keys()])].sort())
                if (recorded[file] !== (current.files.has(file) ? hash(current.files.get(file)) : undefined))
                    configChanges.push({ file, section: project2.section(file) });
        }
        const drift = [];
        for (const [file, record] of Object.entries(manifest.files || {})) {
            const bytes = await fs.readFile(path.join(project.root, file)).catch(() => null);
            if (!bytes) drift.push({ file, action: "missing" });
            else if (hash(bytes) !== record.hash) drift.push({ file, action: "modified" });
        }
        return {
            mode: "quick",
            generator: "cubemx2",
            status: !iocChanged && !drift.length ? "consistent" : "drift_detected",
            iocChanged,
            configChanges,
            drift,
            userCodeChanges: [],
            unclassifiedChanges: [],
            manifestTimestamp: manifest.timestamp,
            guarantee: QUICK_GUARANTEE
        };
    }

    async runDeepCheck(project, op, controller) {
        const service = this.service;
        const root = project.root;
        const runDir = service._runDir(root, op.operationId);
        const logPath = path.join(runDir, "deepCheck.log");
        let stage;
        try {
            const before = await snapshot(root);
            stage = await service._createStage("deep2");
            await fs.mkdir(runDir, { recursive: true });
            await service.store.updateOperation(root, op.operationId, {
                stagePath: stage,
                diagnosticsPath: runDir,
                logPath
            });
            const started = Date.now();
            const { result: generated } = await this._exclusive(() =>
                this._withBackend(project.bundle, stage, logPath, controller.signal, async (backend, open) => {
                    const staged = await this._stageProject(
                        path.join(stage, "project"),
                        path.basename(project.ioc),
                        project.content
                    );
                    return this._generate(
                        backend,
                        open,
                        staged,
                        path.join(stage, "output"),
                        project.summary,
                        controller.signal,
                        started
                    );
                })
            );
            const current = await snapshot(root);
            let result;
            if (fileDiff(before, current).length)
                result = { status: "invalidated", message: "Source project changed during deep check" };
            else {
                const drift = [];
                const newFiles = [];
                const userCodeChanges = [];
                for (const [file, entry] of generated.files) {
                    const user = project2.USER_GROUPS.has(generated.group(file));
                    if (!current.has(file)) newFiles.push(file);
                    else if (!project2.sameContent(slash(file), current.get(file), entry))
                        (user ? userCodeChanges : drift).push({ file, action: user ? "user_modified" : "modified" });
                }
                const generatedDirs = new Set(
                    [...generated.files.keys()].map((file) => path.dirname(file)).filter((dir) => dir !== ".")
                );
                const staleCandidates = [];
                for (const file of [...current.keys()].sort()) {
                    if (generated.files.has(file) || !generatedDirs.has(path.dirname(file))) continue;
                    staleCandidates.push({ file, action: "not_regenerated" });
                    if (staleCandidates.length >= 50) break;
                }
                result = {
                    status: drift.length || newFiles.length ? "drift_detected" : "consistent",
                    drift,
                    newFiles,
                    userCodeChanges,
                    unclassifiedChanges: [],
                    staleCandidates
                };
            }
            await service.store.updateOperation(root, op.operationId, {
                status: "succeeded",
                stage: "done",
                sourceProjectStatus: "unchanged",
                result
            });
            return {
                mode: "deep",
                generator: "cubemx2",
                operationId: op.operationId,
                ...result,
                guarantee: DEEP_GUARANTEE
            };
        } catch (error) {
            if (stage) error.details = { ...error.details, diagnosticsPath: runDir, logPath };
            try {
                await service.store.updateOperation(root, op.operationId, {
                    status: error.code === "CUBEMX_CANCELLED" ? "cancelled" : "failed",
                    diagnostic: error.message,
                    error: { code: error.code, message: error.message, details: { diagnosticsPath: runDir, logPath } }
                });
            } catch {
                // Record update must never mask the original deep-check failure.
            }
            throw error;
        } finally {
            await service._finishJob(root, op.operationId, stage);
            await service._pruneRuns(root).catch(() => {});
        }
    }
}

function rejectContent(params) {
    if (params.candidatePath !== undefined || params.content !== undefined)
        throw failure(
            "INVALID_ARGUMENT",
            "CubeMX2 projects are changed with operations in cubemx.prepare; start with the returned candidateHash"
        );
}

// Agent-facing results stay bounded; a larger result keeps its start and says so.
function limit(data) {
    const text = JSON.stringify(data);
    if (text === undefined || text.length <= MAX_RESULT_CHARS) return data;
    return { truncated: true, size: text.length, preview: text.slice(0, MAX_RESULT_CHARS) };
}

module.exports = { CubeMx2Generator, isIoc2 };
