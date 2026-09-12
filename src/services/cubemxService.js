"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { CubeMxAuthorization } = require("../cubemxAuthorization");
const { failure, inside, installation } = require("./cubemxEnvironment");
const {
    hash,
    parseIoc,
    changes,
    snapshot,
    fileDiff,
    normalizeGenerated,
    stageGeneration,
    assertFreshOutput,
    preserveTextFormatting,
    applyFiles,
    assertUserCodePreserved
} = require("./cubemxProject");
const { runCubeMx } = require("./cubemxRunner");
const {
    CubeMxOperationStore,
    classifyUserCodeMarkers,
    classifyUserCodeChanges,
    changedUserCodeBlockNames,
    atomicWriteJson
} = require("./cubemxOperations");
const { categorizeChanges, validateStructuralIoc } = require("./cubemxCandidate");

function computeParamsHash(params) {
    return hash(
        JSON.stringify({
            candidatePath: params.candidatePath || "",
            content: params.content || "",
            ...(params.candidateHash ? { candidateHash: params.candidateHash } : {}),
            mode: params.mode || "",
            confirmationId: params.confirmationId || "",
            remember: !!params.remember
        })
    );
}

// Persisted operation records stay compact: the bulky log tail stays on disk behind logPath.
const RECORDABLE_ERROR_KEYS = [
    "stage",
    "logPath",
    "failureLine",
    "warningSummary",
    "expectedRoot",
    "candidateDirectory",
    "condition",
    "file",
    "backup",
    "committed",
    "sourceProjectStatus",
    "conflicts",
    "changes",
    "code"
];

function sanitizeErrorDetails(details) {
    if (!details || typeof details !== "object") return undefined;
    const safe = {};
    for (const key of RECORDABLE_ERROR_KEYS) {
        if (details[key] !== undefined) safe[key] = details[key];
    }
    return Object.keys(safe).length ? safe : undefined;
}

class CubeMxService {
    constructor(options) {
        this.options = options;
        this.authorization = new CubeMxAuthorization(options.storage);
        this.jobs = new Map();
        this.activeExecutions = new Map();
        this.recordFailures = new Map();
        this.store = new CubeMxOperationStore(options.storageDir || options.storage?.storageUri?.fsPath);
    }

    async _resolveProjectRoot() {
        const config = this.options.config();
        if (!config.iocPath) throw failure("CUBEMX_IOC_MISSING", "Select an .ioc file in MCU configuration");
        const ioc = await fs.realpath(config.iocPath);
        const roots = await Promise.all(this.options.roots().map((root) => fs.realpath(root)));
        const workspace = roots.find((root) => inside(root, ioc));
        if (!workspace || path.extname(ioc).toLowerCase() !== ".ioc")
            throw failure("PATH_OUTSIDE_WORKSPACE", "Select an .ioc inside this workspace");
        const root = path.dirname(ioc);
        return { workspace, root, ioc, config };
    }

    async inspect(params = {}) {
        if ((this.options.platform || process.platform) !== "win32")
            throw failure("CUBEMX_WINDOWS_ONLY", "CubeMX generation currently supports Windows only");
        const { workspace, root, ioc, config } = await this._resolveProjectRoot();
        const tool = await (this.options.installation || installation)(config.cubemxPath);
        const content = await fs.readFile(ioc, "utf8");
        const values = parseIoc(content);
        validateStructuralIoc(values);
        if (!tool.version || tool.version !== values["MxCube.Version"])
            throw failure(
                "CUBEMX_VERSION_MISMATCH",
                "Use the CubeMX version recorded in .ioc; automatic migration is disabled",
                { installed: tool.version, required: values["MxCube.Version"] }
            );
        if (values["ProjectManager.ProjectName"] !== path.basename(ioc, path.extname(ioc)))
            throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Project name must match the .ioc filename", {
                expectedRoot: path.basename(ioc, path.extname(ioc)),
                candidateDirectory: root,
                condition: "project_name_mismatch"
            });

        let filteredValues = values;
        let prefixApplied = false;
        if (params.prefix) {
            const prefix = String(params.prefix);
            filteredValues = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(prefix)));
            prefixApplied = true;
        }

        if (params.summary && !params.full) {
            return {
                workspace,
                root,
                ioc,
                tool,
                summary: {
                    propertyCount: Object.keys(values).length,
                    chip: values["Mcu.Name"],
                    toolchain: values["ProjectManager.TargetToolchain"],
                    cubemxVersion: values["MxCube.Version"],
                    underRoot: values["ProjectManager.UnderRoot"] === "true",
                    projectName: values["ProjectManager.ProjectName"]
                },
                // Summary mode stays compact: properties are returned only for an explicit prefix filter.
                ...(prefixApplied ? { values: filteredValues } : {}),
                full: false
            };
        }

        return { workspace, root, ioc, tool, content, values: filteredValues };
    }

    async plan(params = {}) {
        const project = await this.inspect();
        let content = params.content === undefined ? project.content : params.content;
        if (params.candidatePath !== undefined) {
            if (params.content !== undefined)
                throw failure("INVALID_ARGUMENT", "Provide content or candidatePath, not both");
            const candidate = await fs.realpath(path.resolve(project.workspace, params.candidatePath));
            if (!inside(project.workspace, candidate) || candidate === project.ioc)
                throw failure(
                    "PATH_OUTSIDE_WORKSPACE",
                    "Candidate must be a separate file inside the selected project workspace"
                );
            if ((await fs.stat(candidate)).size > 1024 * 1024)
                throw failure("CUBEMX_IOC_INVALID", "Candidate exceeds 1 MiB");
            content = await fs.readFile(candidate, "utf8");
        }
        if (params.candidateHash && hash(content) !== params.candidateHash)
            throw failure("CUBEMX_PROJECT_CHANGED", "Candidate changed before execution");
        const values = parseIoc(content);
        validateStructuralIoc(values);
        for (const key of [
            "Mcu.Name",
            "Mcu.CPN",
            "MxCube.Version",
            "ProjectManager.ProjectName",
            "ProjectManager.TargetToolchain",
            "ProjectManager.FirmwarePackage"
        ])
            if (values[key] !== project.values[key])
                throw failure(
                    "CUBEMX_LAYOUT_UNSUPPORTED",
                    "Changing chip, toolchain, name or package version is unsupported",
                    { key }
                );
        const trust = {
            workspace: project.workspace,
            ioc: project.ioc,
            chip: values["Mcu.Name"],
            tool: project.tool,
            output: project.root
        };
        const identity = { ...trust, before: hash(project.content), after: hash(content) };
        const rawChanges = changes(project.values, values);
        const categorized = categorizeChanges(rawChanges);
        return {
            ...project,
            candidate: content,
            identity,
            trust,
            changes: rawChanges,
            categorizedChanges: categorized
        };
    }

    async prepare(params = {}) {
        const plan = await this.plan(params);
        const auth = this.authorization.request(plan);
        const verification = {
            propertiesSyntax: "passed",
            structuralCheck: "passed",
            generation: "notRun",
            writeback: "notRun",
            build: "notRun",
            hardware: "notRun"
        };
        if (params.summary && !params.full) {
            const diffsDir = path.join(this.store.projectDir(plan.root), "diffs");
            await fs.mkdir(diffsDir, { recursive: true });
            const diffFileName = `diff-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.json`;
            const diffPath = path.join(diffsDir, diffFileName);
            await atomicWriteJson(diffPath, {
                ioc: plan.ioc,
                changes: plan.changes,
                categorizedChanges: plan.categorizedChanges
            });
            const truncated = plan.changes.length > 20;
            const displayedChanges = plan.changes.slice(0, 20);
            return {
                ioc: plan.ioc,
                output: plan.root,
                changes: displayedChanges,
                changesSummary: {
                    total: plan.changes.length,
                    shown: displayedChanges.length,
                    truncated,
                    diffPath,
                    byCategory: {
                        ips: plan.categorizedChanges.ips.length,
                        pins: plan.categorizedChanges.pins.length,
                        clock: plan.categorizedChanges.clock.length,
                        metadata: plan.categorizedChanges.metadata.length,
                        other: plan.categorizedChanges.other.length
                    }
                },
                tool: plan.tool,
                verification,
                ...auth
            };
        }
        return {
            ioc: plan.ioc,
            output: plan.root,
            changes: plan.changes,
            categorizedChanges: plan.categorizedChanges,
            tool: plan.tool,
            verification,
            ...auth
        };
    }

    async permission(params = {}) {
        if (params.action === "reset") return this.authorization.reset();
        if (params.action && params.action !== "status") throw failure("INVALID_ARGUMENT", "Unknown permission action");
        const summary = this.authorization.summary();
        try {
            const config = this.options.config();
            const ioc = await fs.realpath(config.iocPath || "");
            const roots = await Promise.all(this.options.roots().map((root) => fs.realpath(root)));
            const workspace = roots.find((root) => inside(root, ioc));
            if (!workspace) throw new Error("Selected .ioc is not inside the workspace");
            const values = require("./javaProperties").parseProperties(await fs.readFile(ioc, "utf8"));
            if (!values["Mcu.Name"]) throw new Error("Chip identity is unavailable");
            const tool = await (this.options.installation || installation)(config.cubemxPath);
            const trust = { workspace, ioc, chip: values["Mcu.Name"], tool, output: path.dirname(ioc) };
            return { ...summary, ...this.authorization.status(trust), applicability: "verified" };
        } catch (error) {
            return { ...summary, trusted: false, applicability: "unknown", warning: error.message };
        }
    }

    async generateCandidate(params = {}) {
        return require("./cubemxCandidate").generateCandidate(this.options, params);
    }

    cancel(params = {}) {
        if (params.operationId) {
            for (const [root, job] of this.jobs.entries()) {
                if (job.operationId === params.operationId) {
                    job.controller.abort();
                    return { cancelled: 1, operationId: params.operationId };
                }
            }
            return {
                cancelled: 0,
                operationId: params.operationId,
                message: "Operation not found or already completed"
            };
        }
        let cancelled = 0;
        for (const job of this.jobs.values()) {
            (job.controller || job).abort();
            cancelled++;
        }
        return { cancelled };
    }

    async start(params = {}) {
        const plan = await this.plan(params);
        const pHash = computeParamsHash(params);
        if (params.requestId) {
            const existing = await this.store.findOperationByRequestId(plan.root, params.requestId);
            if (existing) {
                if (
                    existing.requestParamsHash !== pHash ||
                    (existing.configHash && existing.configHash.after !== plan.identity.after)
                ) {
                    throw failure("CUBEMX_REQUEST_CONFLICT", "Request ID already used with different parameters", {
                        requestId: params.requestId
                    });
                }
                return {
                    operationId: existing.operationId,
                    status: existing.status,
                    stage: existing.stage,
                    deduplicated: true
                };
            }
        }

        if (this.jobs.has(plan.root)) throw failure("CUBEMX_BUSY", "This project is already generating or checking");
        this.authorization.authorize(plan, params.confirmationId, params.remember);

        // Claim the project slot synchronously (no await between the busy check and the claim)
        // so concurrent starts on the same project serialize deterministically.
        const controller = new AbortController();
        const job = { controller, operationId: null, type: "generate" };
        this.jobs.set(plan.root, job);
        let op;
        try {
            op = await this.store.createOperation(plan.root, {
                type: "generate",
                requestId: params.requestId || null,
                requestParamsHash: pHash,
                iocPath: plan.ioc,
                configHash: { before: plan.identity.before, after: plan.identity.after }
            });
        } catch (error) {
            if (this.jobs.get(plan.root) === job) this.jobs.delete(plan.root);
            throw error;
        }
        job.operationId = op.operationId;

        const execPromise = this._runExecution(plan, params, op, controller, this.options.progress).catch(() => {});
        this.activeExecutions.set(op.operationId, execPromise);

        return {
            operationId: op.operationId,
            status: "in_progress",
            stage: "init"
        };
    }

    async status(params = {}) {
        const { root } = await this._resolveProjectRoot();
        if (params.requestId) {
            const op = await this.store.findOperationByRequestId(root, params.requestId);
            return op ? this.recordFailures.get(op.operationId) || op : { status: "none" };
        }
        if (params.operationId) {
            const op = await this.store.getOperation(root, params.operationId);
            if (!op) throw failure("INVALID_ARGUMENT", "Operation not found: " + params.operationId);
            return this.recordFailures.get(op.operationId) || op;
        }
        const op = await this.store.getLatestOperation(root);
        return (
            (op && (this.recordFailures.get(op.operationId) || op)) || {
                status: "none",
                message: "No operations found for this project"
            }
        );
    }

    async execute(params = {}, signal, progress = this.options.progress) {
        const plan = await this.plan(params);
        const pHash = computeParamsHash(params);
        if (params.requestId) {
            const existing = await this.store.findOperationByRequestId(plan.root, params.requestId);
            if (existing) {
                if (
                    existing.requestParamsHash !== pHash ||
                    (existing.configHash && existing.configHash.after !== plan.identity.after)
                ) {
                    throw failure("CUBEMX_REQUEST_CONFLICT", "Request ID already used with different parameters", {
                        requestId: params.requestId
                    });
                }
                if (existing.status === "succeeded" && existing.result) {
                    return existing.result;
                }
                if (existing.status === "in_progress") {
                    if (this.activeExecutions.has(existing.operationId)) {
                        try {
                            await this.activeExecutions.get(existing.operationId);
                        } catch {
                            // active execution may throw, fresh status handled below
                        }
                        const fresh = await this.store.getOperation(plan.root, existing.operationId);
                        if (fresh?.status === "succeeded" && fresh.result) return fresh.result;
                        if (fresh) {
                            throw failure(
                                fresh.error?.code || "CUBEMX_GENERATION_FAILED",
                                fresh.error?.message || fresh.diagnostic || "Previous generation attempt failed",
                                fresh.error?.details
                            );
                        }
                    }
                }
                if (existing.status === "interrupted") {
                    throw failure(
                        existing.error?.code || "CUBEMX_OPERATION_INTERRUPTED",
                        "Previous operation was interrupted by an extension restart; query its record with cubemx.status and review recovery material before retrying",
                        existing.error?.details
                    );
                }
                if (existing.status === "failed" || existing.status === "cancelled") {
                    throw failure(
                        existing.error?.code || "CUBEMX_GENERATION_FAILED",
                        existing.error?.message || existing.diagnostic || "Previous generation attempt failed",
                        existing.error?.details
                    );
                }
                throw failure("CUBEMX_BUSY", `Operation ${existing.operationId} is currently ${existing.status}`);
            }
        }

        if (this.jobs.has(plan.root)) throw failure("CUBEMX_BUSY", "This project is already generating or checking");
        this.authorization.authorize(plan, params.confirmationId, params.remember);

        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) controller.abort();

        // Claim the project slot synchronously before any await (see start()).
        const job = { controller, operationId: null, type: "generate" };
        this.jobs.set(plan.root, job);
        let op;
        try {
            op = await this.store.createOperation(plan.root, {
                type: "generate",
                requestId: params.requestId || null,
                requestParamsHash: pHash,
                iocPath: plan.ioc,
                configHash: { before: plan.identity.before, after: plan.identity.after }
            });
        } catch (error) {
            signal?.removeEventListener("abort", cancel);
            if (this.jobs.get(plan.root) === job) this.jobs.delete(plan.root);
            throw error;
        }
        job.operationId = op.operationId;

        const execPromise = this._runExecution(plan, params, op, controller, progress);
        this.activeExecutions.set(op.operationId, execPromise);

        try {
            return await execPromise;
        } finally {
            signal?.removeEventListener("abort", cancel);
        }
    }

    async _runExecution(plan, params, op, controller, progress) {
        let stage;
        let backup;
        try {
            const before = await snapshot(plan.root);
            const name = path.basename(plan.ioc);
            if (before.get(name)?.hash !== plan.identity.before)
                throw failure("CUBEMX_PROJECT_CHANGED", ".ioc changed after confirmation");

            stage = await fs.mkdtemp(path.join(plan.root, ".emberprobe-cubemx-"));
            await this.store.updateOperation(plan.root, op.operationId, { stagePath: stage });

            const baseline = path.join(stage, "baseline");
            const candidate = path.join(stage, "candidate");
            const run = this.options.run || runCubeMx;
            const started = Date.now();

            const ownedFiles = new Set([name, ".mxproject"]);
            const generationWarnings = new Set();
            const generate = async (directory, files, runStage) => {
                if (controller.signal.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
                const { output, mains } = await stageGeneration(directory, files, name);
                const timeoutMs = 300000 - (Date.now() - started);
                if (timeoutMs <= 0) throw failure("CUBEMX_TIMEOUT", "Generation exceeded five minutes");
                const result = await run(plan.tool, directory, name, {
                    signal: controller.signal,
                    timeoutMs,
                    stage: runStage
                });
                if (!result.logPath)
                    await fs.writeFile(path.join(directory, ".emberprobe-cubemx-output.log"), result.log || "");
                for (const reported of result.generatedFiles || []) {
                    const relative = path.relative(output, reported);
                    if (inside(output, reported)) ownedFiles.add(relative);
                }
                for (const warning of result.warnings || []) generationWarnings.add(warning);
                await this.store.updateOperation(plan.root, op.operationId, {
                    logPath: result.logPath || path.join(directory, ".emberprobe-cubemx-output.log")
                });
                const raw = normalizeGenerated(files, await snapshot(directory), name);
                await assertFreshOutput(output, mains, result.generatedFiles);
                const generated = preserveTextFormatting(files, raw);
                generated.set(name, files.get(name));
                return generated;
            };

            progress?.("baseline");
            await this.store.updateOperation(plan.root, op.operationId, {
                stage: "baseline",
                sourceProjectStatus: "unchanged"
            });
            const base = await generate(baseline, before, "baseline");
            const drift = fileDiff(before, base).filter((entry) => before.has(entry.file));
            if (drift.length) {
                const error = failure(
                    "CUBEMX_BASELINE_DRIFT",
                    "Existing files cannot be reproduced; review hand edits before generating",
                    { changes: drift, stage }
                );
                if (drift.some((entry) => entry.file.replace(/\\/g, "/") === "cmake/stm32cubemx/CMakeLists.txt"))
                    error.suggestedActions.unshift(
                        "Review cmake/stm32cubemx/CMakeLists.txt for manual edits: CubeMX regenerates this file. " +
                            "If custom sources were added there, move their entries to target_sources(${CMAKE_PROJECT_NAME} PRIVATE ...) " +
                            "in the top-level CMakeLists.txt, remove the duplicate generated-file entries, then prepare again."
                    );
                throw error;
            }

            progress?.("generating");
            await this.store.updateOperation(plan.root, op.operationId, {
                stage: "generating",
                sourceProjectStatus: "unchanged"
            });
            const input = new Map(before);
            input.set(name, { bytes: Buffer.from(plan.candidate), hash: hash(plan.candidate) });
            const after = await generate(candidate, input, "generating");
            assertUserCodePreserved(before, after);

            if (controller.signal.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
            const currentPlan = await this.plan(params);
            if (JSON.stringify(currentPlan.identity) !== JSON.stringify(plan.identity))
                throw failure("CUBEMX_PROJECT_CHANGED", "Configuration changed during generation");

            progress?.("layout");
            await this.store.updateOperation(plan.root, op.operationId, {
                stage: "layout",
                sourceProjectStatus: "unchanged"
            });

            backup = path.join(stage, "backup");
            // Must update record before writing files
            await this.store.updateOperation(plan.root, op.operationId, {
                stage: "writing",
                sourceProjectStatus: "unchanged",
                backupPath: backup
            });

            progress?.("writing");
            let changed;
            const writeFiles = this.options.applyFiles || applyFiles;
            try {
                changed = await writeFiles(plan.root, before, after, backup);
            } catch (writeErr) {
                // A pre-write rejection means nothing was ever written: the project is unchanged,
                // not rolled back. Empty conflicts after real writes mean the rollback succeeded.
                let sourceProjectStatus;
                if (writeErr.details?.condition === "pre_write_change") sourceProjectStatus = "unchanged";
                else if (!writeErr.details?.conflicts || writeErr.details.conflicts.length === 0)
                    sourceProjectStatus = "rolledBack";
                else sourceProjectStatus = "recoveryRequired";
                try {
                    await this.store.updateOperation(plan.root, op.operationId, {
                        stage: "rollback",
                        sourceProjectStatus,
                        status: "failed",
                        diagnostic: writeErr.message
                    });
                } catch {
                    // Record update must never mask the original write failure.
                }
                throw writeErr;
            }

            // Readback check
            for (const [fileName, expected] of after) {
                const targetPath = path.join(plan.root, fileName);
                const currentBytes = await fs.readFile(targetPath).catch(() => null);
                if (!currentBytes || hash(currentBytes) !== expected.hash) {
                    await this.store.updateOperation(plan.root, op.operationId, {
                        stage: "writing",
                        sourceProjectStatus: "unknown",
                        status: "failed",
                        diagnostic: `Readback verification failed for ${fileName}`
                    });
                    throw failure("CUBEMX_WRITE_FAILED", `Readback verification failed for ${fileName}`, {
                        file: fileName
                    });
                }
            }

            let permissionWarning;
            if (params.remember) {
                try {
                    await this.authorization.remember(plan);
                } catch (error) {
                    permissionWarning = error.message;
                }
            }

            const manifestFiles = {};
            for (const [fileName, fileEntry] of after) {
                const text = fileEntry.bytes.toString("utf8");
                const marked = /@attention[\s\S]*STMicroelectronics|Generated by STM32CubeMX/.test(text);
                if (!ownedFiles.has(fileName) && !marked && before.get(fileName)?.hash === fileEntry.hash) continue;
                let skeletonHash = fileEntry.hash;
                const userBlocks = {};
                if (/\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(fileName)) {
                    const markers = classifyUserCodeMarkers(fileEntry.bytes.toString("utf8"));
                    if (markers.valid) {
                        const skeleton = fileEntry.bytes
                            .toString("utf8")
                            .replace(
                                /\/\* USER CODE BEGIN ([^*\r\n]+)\*\/[\s\S]*?\/\* USER CODE END \1\*\//g,
                                "/* USER CODE: $1 */"
                            )
                            .replace(/\r\n/g, "\n");
                        skeletonHash = hash(skeleton);
                        for (const [bName, content] of markers.blocks) {
                            userBlocks[bName] = hash(content.replace(/\r\n/g, "\n"));
                        }
                    }
                }
                manifestFiles[fileName] = {
                    hash: fileEntry.hash,
                    skeletonHash,
                    userBlocks
                };
            }

            const manifest = {
                schemaVersion: 2,
                timestamp: new Date().toISOString(),
                iocPath: plan.ioc,
                iocHash: plan.identity.after,
                iocProperties: parseIoc(plan.candidate),
                tool: {
                    executable: plan.tool.executable,
                    version: plan.tool.version
                },
                firmwarePackage: plan.values["ProjectManager.FirmwarePackage"] || "",
                files: manifestFiles
            };

            const result = {
                generated: true,
                compiled: false,
                operationId: op.operationId,
                ioc: plan.ioc,
                changes: changed,
                backup,
                sourceProjectStatus: "committed",
                permissionWarning,
                warnings: [...generationWarnings].slice(0, 20),
                warningCount: generationWarnings.size,
                permission: this.authorization.status(plan.trust)
            };

            let recordSaveFailed = false;
            try {
                await this.store.saveManifest(plan.root, manifest);
                await this.store.updateOperation(plan.root, op.operationId, {
                    status: "succeeded",
                    stage: "done",
                    sourceProjectStatus: "committed",
                    backupPath: backup,
                    result
                });
            } catch (err) {
                recordSaveFailed = true;
            }

            if (recordSaveFailed) {
                this.recordFailures.set(op.operationId, {
                    ...op,
                    status: "failed",
                    stage: "done",
                    sourceProjectStatus: "committed",
                    diagnostic: "Source files committed, but generation record could not be saved",
                    error: { code: "CUBEMX_RECORD_SAVE_FAILED", details: { committed: true, backup } }
                });
                throw failure(
                    "CUBEMX_RECORD_SAVE_FAILED",
                    "Source files committed, but operation record could not be saved",
                    { committed: true, sourceProjectStatus: "committed", backup, stage }
                );
            }

            return result;
        } catch (error) {
            if (stage) error.details = { ...error.details, stage };
            try {
                const currentOp = await this.store.getOperation(plan.root, op.operationId);
                if (currentOp?.sourceProjectStatus !== "committed" || error.code === "CUBEMX_RECORD_SAVE_FAILED") {
                    await this.store.updateOperation(plan.root, op.operationId, {
                        status: error.code === "CUBEMX_CANCELLED" ? "cancelled" : "failed",
                        diagnostic: error.message,
                        ...(error.details?.committed ? { sourceProjectStatus: "committed" } : {}),
                        error: {
                            code: error.code,
                            message: error.message,
                            // Status-only callers lose thrown-error details otherwise.
                            details: sanitizeErrorDetails(error.details)
                        }
                    });
                }
            } catch {
                // A failing store must never replace the original generation error.
            }
            throw error;
        } finally {
            this.jobs.delete(plan.root);
            this.activeExecutions.delete(op.operationId);
        }
    }

    async check(params = {}) {
        const mode = params.mode || "quick";
        if (mode === "quick") {
            // Quick check only hashes files against the manifest: it must not require a working
            // CubeMX installation, a matching tool version, or Windows.
            const project = await this._resolveProjectRoot();
            const manifest = await this.store.getManifest(project.root);
            if (!manifest || manifest.schemaVersion !== 2) {
                return {
                    mode: "quick",
                    status: "unknown",
                    message:
                        "No compatible generation ownership manifest found; run a confirmed generation to establish one",
                    guarantee:
                        "Quick check proves changes relative to the recorded manifest only. Does not verify build or hardware behavior."
                };
            }

            const currentIocContent = await fs.readFile(project.ioc, "utf8");
            const currentIocHash = hash(currentIocContent);
            const iocChanged = currentIocHash !== manifest.iocHash;
            let configChanges = [];
            if (iocChanged) {
                const recordedProperties = manifest.iocProperties || {};
                configChanges = changes(recordedProperties, parseIoc(currentIocContent));
            }

            const drift = [];
            const userCodeChanges = [];
            const unclassifiedChanges = [];

            for (const [fileName, record] of Object.entries(manifest.files || {})) {
                const targetPath = path.join(project.root, fileName);
                const stat = await fs.stat(targetPath).catch(() => null);
                if (!stat) {
                    drift.push({ file: fileName, action: "missing" });
                    continue;
                }
                const bytes = await fs.readFile(targetPath);
                const fileHash = hash(bytes);
                const expectedHash = typeof record === "string" ? record : record.hash;
                if (fileHash === expectedHash) continue;

                if (/\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(fileName)) {
                    const text = bytes.toString("utf8");
                    const markers = classifyUserCodeMarkers(text);
                    if (!markers.valid) {
                        unclassifiedChanges.push({ file: fileName, reason: markers.reason });
                        continue;
                    }
                    const skeleton = text
                        .replace(
                            /\/\* USER CODE BEGIN ([^*\r\n]+)\*\/[\s\S]*?\/\* USER CODE END \1\*\//g,
                            "/* USER CODE: $1 */"
                        )
                        .replace(/\r\n/g, "\n");
                    const currentSkeletonHash = hash(skeleton);
                    if (record.skeletonHash && currentSkeletonHash === record.skeletonHash) {
                        const changedBlocks = Object.entries(record.userBlocks || {})
                            .filter(([bName, blockHash]) => {
                                const currentBlock = markers.blocks.get(bName);
                                return (
                                    currentBlock === undefined ||
                                    hash(currentBlock.replace(/\r\n/g, "\n")) !== blockHash
                                );
                            })
                            .map(([bName]) => bName);
                        userCodeChanges.push({
                            file: fileName,
                            action: "user_code_modified",
                            blocks: changedBlocks
                        });
                    } else {
                        drift.push({ file: fileName, action: "modified" });
                    }
                } else {
                    drift.push({ file: fileName, action: "modified" });
                }
            }

            const consistent = !iocChanged && drift.length === 0 && unclassifiedChanges.length === 0;
            return {
                mode: "quick",
                status: consistent ? "consistent" : "drift_detected",
                iocChanged,
                configChanges,
                drift,
                userCodeChanges,
                unclassifiedChanges,
                manifestTimestamp: manifest.timestamp,
                guarantee:
                    "Quick check proves changes relative to the recorded manifest only. Does not verify build or hardware behavior."
            };
        }

        if (mode === "deep") {
            const project = await this.inspect();
            if (this.jobs.has(project.root))
                throw failure("CUBEMX_BUSY", "This project is already generating or checking");

            const controller = new AbortController();
            // Claim the project slot synchronously before any await (see start()).
            const job = { controller, operationId: null, type: "deepCheck" };
            this.jobs.set(project.root, job);
            let op;
            try {
                op = await this.store.createOperation(project.root, {
                    type: "deepCheck",
                    requestId: params.requestId || null,
                    requestParamsHash: computeParamsHash(params),
                    iocPath: project.ioc
                });
            } catch (error) {
                if (this.jobs.get(project.root) === job) this.jobs.delete(project.root);
                throw error;
            }
            job.operationId = op.operationId;

            const execution = this._runDeepCheck(project, op, controller);
            this.activeExecutions.set(
                op.operationId,
                execution.catch(() => {})
            );
            if (params.wait) return execution;
            // Queryable background operation: results land in the operation record, so a lost
            // response can be recovered with cubemx.status instead of re-running CubeMX.
            return { mode: "deep", operationId: op.operationId, status: "in_progress", stage: "init" };
        }

        throw failure("INVALID_ARGUMENT", "Unknown check mode: " + mode);
    }

    async _runDeepCheck(project, op, controller) {
        const root = project.root;
        let stage;
        try {
            const before = await snapshot(root);
            const name = path.basename(project.ioc);
            stage = await fs.mkdtemp(path.join(root, ".emberprobe-cubemx-deep-"));
            await this.store.updateOperation(root, op.operationId, { stagePath: stage });

            const run = this.options.run || runCubeMx;
            const { output, mains } = await stageGeneration(stage, before, name);
            const runResult = await run(project.tool, stage, name, {
                signal: controller.signal,
                timeoutMs: 300000,
                stage: "deepCheck"
            });

            const raw = normalizeGenerated(before, await snapshot(stage), name);
            await assertFreshOutput(output, mains, runResult.generatedFiles);
            const generated = preserveTextFormatting(before, raw);
            generated.set(name, before.get(name));

            // Check concurrency change in source project
            const current = await snapshot(root);
            if (fileDiff(before, current).length > 0) {
                const invalidated = {
                    status: "invalidated",
                    message: "Source project changed during deep check"
                };
                await this.store.updateOperation(root, op.operationId, {
                    status: "succeeded",
                    stage: "done",
                    sourceProjectStatus: "unchanged",
                    result: invalidated
                });
                return {
                    mode: "deep",
                    operationId: op.operationId,
                    ...invalidated,
                    guarantee:
                        "Deep check proves regenerability consistency under current tools. Does not verify build or hardware behavior."
                };
            }

            const drift = [];
            const newFiles = [];
            const userCodeChanges = [];
            const unclassifiedChanges = [];

            for (const [fileName, genEntry] of generated) {
                if (!current.has(fileName)) {
                    newFiles.push(fileName);
                } else {
                    const curEntry = current.get(fileName);
                    if (curEntry.hash !== genEntry.hash) {
                        if (/\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(fileName)) {
                            const classification = classifyUserCodeChanges(
                                genEntry.bytes.toString("utf8"),
                                curEntry.bytes.toString("utf8")
                            );
                            if (!classification.classifiable) {
                                unclassifiedChanges.push({ file: fileName, reason: classification.reason });
                            } else if (!classification.generatedChanged && classification.userChanged) {
                                userCodeChanges.push({
                                    file: fileName,
                                    action: "user_code_modified",
                                    blocks: changedUserCodeBlockNames(
                                        genEntry.bytes.toString("utf8"),
                                        curEntry.bytes.toString("utf8")
                                    )
                                });
                            } else {
                                drift.push({ file: fileName, action: "modified" });
                            }
                        } else {
                            drift.push({ file: fileName, action: "modified" });
                        }
                    }
                }
            }

            // Informational only: files inside directories that generation populates but that a
            // fresh regeneration no longer produces (e.g. leftovers after removing a peripheral).
            // Root-level user files are normal and never reported.
            const generatedDirs = new Set(
                [...generated.keys()].map((fileName) => path.dirname(fileName)).filter((dir) => dir !== ".")
            );
            const staleCandidates = [];
            for (const fileName of [...current.keys()].sort()) {
                if (generated.has(fileName)) continue;
                const dir = path.dirname(fileName);
                if (dir === "." || !generatedDirs.has(dir)) continue;
                staleCandidates.push({ file: fileName, action: "not_regenerated" });
                if (staleCandidates.length >= 50) break;
            }

            const consistent = drift.length === 0 && unclassifiedChanges.length === 0 && newFiles.length === 0;
            const status = consistent ? "consistent" : "drift_detected";

            const result = {
                status,
                drift,
                newFiles,
                userCodeChanges,
                unclassifiedChanges,
                staleCandidates
            };

            await this.store.updateOperation(root, op.operationId, {
                status: "succeeded",
                stage: "done",
                sourceProjectStatus: "unchanged",
                result
            });

            return {
                mode: "deep",
                operationId: op.operationId,
                ...result,
                guarantee:
                    "Deep check proves regenerability consistency under current tools. Does not verify build or hardware behavior."
            };
        } catch (err) {
            if (stage) {
                // The stage directory is removed below, so persist its CubeMX log first:
                // deep-check failures must keep their diagnostics like generation failures do.
                const persistedLog = path.join(this.store.projectDir(root), "logs", `deep-${op.operationId}.log`);
                try {
                    await fs.mkdir(path.dirname(persistedLog), { recursive: true });
                    await fs.copyFile(path.join(stage, ".emberprobe-cubemx-output.log"), persistedLog);
                    err.details = { ...err.details, logPath: persistedLog };
                } catch {
                    // No stage log (e.g. CubeMX never started); keep the original error details.
                }
            }
            try {
                await this.store.updateOperation(root, op.operationId, {
                    status: err.code === "CUBEMX_CANCELLED" ? "cancelled" : "failed",
                    diagnostic: err.message,
                    error: { code: err.code, message: err.message, details: sanitizeErrorDetails(err.details) }
                });
            } catch {
                // Record update must never mask the original deep-check failure.
            }
            throw err;
        } finally {
            if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
            this.jobs.delete(root);
            this.activeExecutions.delete(op.operationId);
        }
    }
}

module.exports = { CubeMxService };
