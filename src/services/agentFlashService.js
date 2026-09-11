"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { quoteTclWord } = require("../openocdRunner");
const { resolveOpenOcdLaunch } = require("../openocdScripts");
const { runOpenOcdOnce } = require("./openocdExec");
const { probeOpenOcdCompatibility } = require("../../skills/_emberprobe/flash-common");

class AgentFlashService {
    constructor(options) {
        this.coordinator = options.coordinator;
        this.authorization = options.authorization;
        this.isDebugActive = options.isDebugActive;
        this.resolveLaunch = options.resolveLaunch || resolveOpenOcdLaunch;
        this.check = options.check || probeOpenOcdCompatibility;
        this.run = options.run || runOpenOcdOnce;
    }

    async execute(params, verify = false) {
        if (this.isDebugActive()) throw Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
        const lease = this.coordinator.acquire("download");
        let temporary;
        try {
            const elf = await fs.realpath(String(params.elf || ""));
            const buffer = await fs.readFile(elf);
            const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
            if (sha256 !== params.elfSha256)
                throw Object.assign(new Error("ELF changed before execution"), {
                    code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION"
                });
            const launch = this.resolveLaunch(params.openocd, params.probe, params.target);
            const compatible = await this.check(launch.executable);
            if (!compatible.compatible) throw new Error(`Incompatible OpenOCD ${compatible.version}`);
            if (this.isDebugActive()) throw Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
            if (!verify) {
                if (!params.confirmationId) throw new Error("Flash confirmation is required");
                this.authorization.authorize(
                    {
                        elf: { path: elf, sha256 },
                        target: params.target,
                        probe: params.probe,
                        openocd: params.openocd
                    },
                    params.confirmationId
                );
            }
            // OpenOCD consumes exactly the bytes whose hash was authorized, even if a build replaces the original ELF.
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-"));
            const snapshot = path.join(temporary, "firmware.elf");
            await fs.writeFile(snapshot, buffer, { flag: "wx", mode: 0o600 });
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
            let verifyResult;
            const execution = await this.run({
                executable: launch.executable,
                probe: params.probe,
                target: params.target,
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
            return {
                verified,
                elf,
                elfSha256: sha256,
                code: verified ? 0 : 1,
                detail: failed || (verified ? "" : `OpenOCD exited with code ${execution.exitCode}`),
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
