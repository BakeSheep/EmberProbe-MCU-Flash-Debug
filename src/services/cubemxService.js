"use strict";
const fs = require("fs/promises");
const path = require("path");
const { CubeMxAuthorization } = require("../cubemxAuthorization");
const { failure, inside, installation } = require("./cubemxEnvironment");
const {
    hash,
    parseIoc,
    changes,
    snapshot,
    fileDiff,
    materialize,
    applyFiles,
    assertUserCodePreserved
} = require("./cubemxProject");
const { runCubeMx } = require("./cubemxRunner");

class CubeMxService {
    constructor(options) {
        this.options = options;
        this.authorization = new CubeMxAuthorization(options.storage);
        this.jobs = new Map();
    }
    async inspect() {
        if ((this.options.platform || process.platform) !== "win32")
            throw failure("CUBEMX_WINDOWS_ONLY", "CubeMX generation currently supports Windows only");
        const config = this.options.config();
        if (!config.iocPath) throw failure("CUBEMX_IOC_MISSING", "Select an .ioc file in MCU configuration");
        const ioc = await fs.realpath(config.iocPath);
        const roots = await Promise.all(this.options.roots().map((root) => fs.realpath(root)));
        const workspace = roots.find((root) => inside(root, ioc));
        if (!workspace || path.extname(ioc).toLowerCase() !== ".ioc")
            throw failure("PATH_OUTSIDE_WORKSPACE", "Select an .ioc inside this workspace");
        const tool = await (this.options.installation || installation)(config.cubemxPath);
        const content = await fs.readFile(ioc, "utf8");
        const values = parseIoc(content);
        if (!tool.version || tool.version !== values["MxCube.Version"])
            throw failure(
                "CUBEMX_VERSION_MISMATCH",
                "Use the CubeMX version recorded in .ioc; automatic migration is disabled",
                { installed: tool.version, required: values["MxCube.Version"] }
            );
        const root = path.dirname(ioc);
        if (values["ProjectManager.ProjectName"] !== path.basename(ioc, path.extname(ioc)))
            throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Project name must match the .ioc filename");
        return { workspace, root, ioc, tool, content, values };
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
        const values = parseIoc(content);
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
        return { ...project, candidate: content, identity, trust, changes: changes(project.values, values) };
    }
    async prepare(params = {}) {
        const plan = await this.plan(params);
        return {
            ioc: plan.ioc,
            output: plan.root,
            changes: plan.changes,
            tool: plan.tool,
            ...this.authorization.request(plan)
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
    cancel() {
        for (const controller of this.jobs.values()) controller.abort();
        return { cancelled: this.jobs.size };
    }
    async execute(params = {}, signal, progress = this.options.progress) {
        const plan = await this.plan(params);
        if (this.jobs.has(plan.root)) throw failure("CUBEMX_BUSY", "This project is already generating");
        this.authorization.authorize(plan, params.confirmationId, params.remember);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) controller.abort();
        this.jobs.set(plan.root, controller);
        let stage;
        try {
            const before = await snapshot(plan.root);
            const name = path.basename(plan.ioc);
            if (before.get(name)?.hash !== plan.identity.before)
                throw failure("CUBEMX_PROJECT_CHANGED", ".ioc changed after confirmation");
            stage = await fs.mkdtemp(path.join(plan.root, ".emberprobe-cubemx-"));
            const baseline = path.join(stage, "baseline");
            const candidate = path.join(stage, "candidate");
            const run = this.options.run || runCubeMx;
            const started = Date.now();
            const generate = async (directory, files) => {
                if (controller.signal.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
                await materialize(directory, files);
                const timeoutMs = 300000 - (Date.now() - started);
                if (timeoutMs <= 0) throw failure("CUBEMX_TIMEOUT", "Generation exceeded five minutes");
                const result = await run(plan.tool, directory, name, { signal: controller.signal, timeoutMs });
                await fs.writeFile(path.join(directory, ".emberprobe-cubemx-output.log"), result.log || "");
                const generated = await snapshot(directory);
                if (![...generated.keys()].some((file) => /(?:^|[/\\])main\.c$/i.test(file)))
                    throw failure("CUBEMX_OUTPUT_MISSING", "CubeMX did not produce main.c", result);
                generated.set(name, files.get(name));
                return generated;
            };
            progress?.("baseline");
            const base = await generate(baseline, before);
            const drift = fileDiff(before, base).filter((entry) => before.has(entry.file));
            if (drift.length)
                throw failure(
                    "CUBEMX_BASELINE_DRIFT",
                    "Existing files cannot be reproduced; review hand edits before generating",
                    { changes: drift, stage }
                );
            progress?.("generating");
            const input = new Map(before);
            input.set(name, { bytes: Buffer.from(plan.candidate), hash: hash(plan.candidate) });
            const after = await generate(candidate, input);
            assertUserCodePreserved(before, after);
            if (controller.signal.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
            const currentPlan = await this.plan(params);
            if (JSON.stringify(currentPlan.identity) !== JSON.stringify(plan.identity))
                throw failure("CUBEMX_PROJECT_CHANGED", "Configuration changed during generation");
            progress?.("writing");
            const backup = path.join(stage, "backup");
            const changed = await applyFiles(plan.root, before, after, backup);
            let permissionWarning;
            if (params.remember) {
                try {
                    await this.authorization.remember(plan);
                } catch (error) {
                    permissionWarning = error.message;
                }
            }
            return {
                generated: true,
                compiled: false,
                ioc: plan.ioc,
                changes: changed,
                backup,
                permissionWarning,
                permission: this.authorization.status(plan.trust)
            };
        } catch (error) {
            if (stage) error.details = { ...error.details, stage };
            throw error;
        } finally {
            this.jobs.delete(plan.root);
            signal?.removeEventListener("abort", cancel);
        }
    }
}
module.exports = { CubeMxService };
