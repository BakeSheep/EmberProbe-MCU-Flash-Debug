"use strict";

const fs = require("fs/promises");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");
const os = require("os");
const path = require("path");
const { resolveExecutablePath } = require("../../skills/_emberprobe/openocd-launch");
const { quoteTclWord } = require("../openocdRunner");
const { resolveOpenOcdLaunch } = require("../openocdScripts");
const { runOpenOcdOnce } = require("./openocdExec");
const { probeOpenOcdCompatibility } = require("../../skills/_emberprobe/flash-common");
const { prepareProbeConnection } = require("../../skills/_emberprobe/probe-preflight");

class AgentFlashService {
    constructor(options) {
        this.getConfig = options.getConfig;
        this.coordinator = options.coordinator;
        this.authorization = options.authorization;
        this.isDebugActive = options.isDebugActive;
        this.resolveLaunch = options.resolveLaunch || resolveOpenOcdLaunch;
        this.check = options.check || probeOpenOcdCompatibility;
        this.run = options.run || runOpenOcdOnce;
        this.prepare = options.prepare || prepareProbeConnection;
        this.recordSuccess = options.recordSuccess || (async () => {});
    }

    request(params) {
        const configured = this.getConfig();
        const executable = resolveExecutablePath(configured.openocdPath);
        if (!executable) throw new Error("Configure OpenOCD before flashing");
        for (const key of ["openocd", "executable"]) {
            if (params[key] !== undefined && resolveExecutablePath(params[key]) !== executable)
                throw Object.assign(new Error("Agent OpenOCD must match the configured executable"), {
                    code: "OPENOCD_EXECUTABLE_MISMATCH"
                });
        }
        return {
            executable,
            openocd: executable,
            probe: params.probe ?? configured.debugger,
            target: params.target ?? configured.mcu,
            transport: params.transport ?? configured.transport,
            probeSerial: params.probeSerial ?? configured.probeSerial,
            adapterSpeedKhz: params.adapterSpeedKhz ?? configured.adapterSpeedKhz
        };
    }

    async authorize(params = {}) {
        const request = this.request(params);
        const elf = await inspectElf(params.elf);
        this.assertDigest(elf.sha256, params.elfSha256);
        this.request(request);
        const connection = await this.prepare(request);
        this.request(request);
        return this.authorization.authorize({ ...this.identity(request, connection), elf }, params.confirmationId);
    }

    assertDigest(actual, expected) {
        if (actual !== expected)
            throw Object.assign(new Error("ELF changed before execution"), {
                code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION"
            });
    }

    identity(request, connection) {
        return {
            transport: connection.transport,
            target: request.target,
            probe: request.probe,
            openocd: connection.openocd,
            probeSerial: connection.probeSerial,
            adapterSpeedKhz: connection.adapterSpeedKhz
        };
    }

    async execute(params = {}, verify = false) {
        const request = this.request(params);
        if (this.isDebugActive()) throw Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
        const lease = this.coordinator.acquire("download");
        let temporary;
        try {
            if (!verify && !params.confirmationId) throw new Error("Flash confirmation is required");
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-"));
            const snapshot = path.join(temporary, "firmware.elf");
            const inspected = await inspectElf(params.elf, { snapshot });
            const { path: elf, sha256 } = inspected;
            this.assertDigest(sha256, params.elfSha256);
            this.request(request);
            const launch = this.resolveLaunch(request.executable, request.probe, request.target, request.transport);
            const compatible = await this.check(launch.executable);
            if (!compatible.compatible) throw new Error(`Incompatible OpenOCD ${compatible.version}`);
            const connection = await this.prepare(request, { resolveLaunch: () => launch });
            if (this.isDebugActive()) throw Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
            if (!verify)
                this.authorization.authorize(
                    { ...this.identity(request, connection), elf: inspected },
                    params.confirmationId
                );
            // Only the private, bounded snapshot whose digest was authorized is consumed.
            const word = quoteTclWord(snapshot.replace(/\\/g, "/"));
            const verifyCommand =
                'set o [[target current] curstate]; set h 0; set rc 0; set msg ""; ' +
                'if {$o ne "halted"} { set rc [catch {halt} msg]; if {!$rc} { set h 1 } }; ' +
                `if {!$rc} { set rc [catch { verify_image ${word} } msg] }; ` +
                "if {$h} { set rrc [catch {resume} rmsg]; if {!$rc && $rrc} { set rc $rrc; set msg $rmsg } }; " +
                'if {$rc} { echo "EP_VERIFY FAIL $msg" } else { echo "EP_VERIFY OK" }; shutdown';
            const commands = verify
                ? ["set _ep_target [target current]; $_ep_target configure -work-area-size 0", "init", verifyCommand]
                : [
                      "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }",
                      `program ${word} verify reset exit`
                  ];
            if (lease.released || this.isDebugActive())
                throw Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
            this.request(request);
            let verifyResult;
            const execution = await this.run({
                executable: launch.executable,
                probe: request.probe,
                target: request.target,
                transport: connection.transport,
                probeSerial: connection.probeSerial,
                adapterSpeedKhz: connection.adapterSpeedKhz,
                inventory: connection.inventory,
                resolveLaunch: () => launch,
                buildCommands: () => commands,
                timeoutMs: 120000,
                waitForCloseOnTimeout: true,
                onLine: (line) => {
                    if (/^\s*EP_VERIFY (OK|FAIL)\b/.test(line)) verifyResult = line;
                }
            });
            const resultLines = verifyResult ? [verifyResult] : execution.openocdTail;
            const failed = resultLines.find((line) => /^\s*EP_VERIFY FAIL\b/.test(line));
            const verified =
                execution.exitCode === 0 &&
                (!verify || (!failed && resultLines.some((line) => /^\s*EP_VERIFY OK\b/.test(line))));
            if (verified && !lease.released) await this.recordSuccess(connection);
            return {
                verified,
                elf,
                elfSha256: sha256,
                code: verified ? 0 : 1,
                detail:
                    failed ||
                    (verified ? "" : execution.diagnostic?.message || `OpenOCD exited with code ${execution.exitCode}`),
                ...(verified ? {} : { diagnostic: execution.diagnostic }),
                commands: execution.commands,
                lines: execution.openocdTail
            };
        } finally {
            try {
                if (temporary) await fs.rm(temporary, { recursive: true, force: true });
            } finally {
                lease.release();
            }
        }
    }
}

module.exports = { AgentFlashService };
