"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { minimalElf } = require("./helpers/elf-fixture");
const { inspectElf, MAX_ELF_BYTES } = require("../skills/_emberprobe/elf-file");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { FlashAuthorization } = require("../src/flashAuthorization");

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-safety-"));
    const file = path.join(root, "firmware.elf");
    const data = minimalElf();
    const digest = crypto.createHash("sha256").update(data).digest("hex");
    await fs.writeFile(file, data);
    try {
        const inspected = await inspectElf(file);
        assert.strictEqual(inspected.sha256, digest);
        const snapshot = path.join(root, "snapshot.elf");
        await inspectElf(file, { snapshot });
        assert.deepStrictEqual(await fs.readFile(snapshot), data);
        await assert.rejects(inspectElf(file, { snapshot }), { code: "EEXIST" });
        await assert.rejects(inspectElf(file, { signal: AbortSignal.abort() }), { code: "ELF_READ_CANCELLED" });
        await assert.rejects(inspectElf(root), { code: "ELF_FILE_INVALID" });
        await fs.writeFile(file, "not elf");
        await assert.rejects(inspectElf(file), { code: "ELF_FILE_INVALID" });
        await fs.writeFile(file, data);
        const large = await fs.open(path.join(root, "large.elf"), "w");
        await large.truncate(MAX_ELF_BYTES + 1);
        await large.close();
        await assert.rejects(inspectElf(path.join(root, "large.elf")), { code: "ELF_TOO_LARGE" });

        // Controlled file handles exercise growth and boundaries without allocating
        // a 64 MiB test buffer or racing another process.
        const originalOpen = fs.open;
        let closed = 0;
        try {
            let total = MAX_ELF_BYTES,
                reported = MAX_ELF_BYTES,
                modified = false;
            fs.open = async () => {
                let offset = 0,
                    stats = 0;
                return {
                    stat: async () => ({ isFile: () => true, size: reported, mtimeMs: modified ? stats++ : 0 }),
                    read: async (buffer) => {
                        const count = Math.min(total - offset, buffer.length);
                        buffer.fill(0);
                        if (offset === 0) data.copy(buffer);
                        offset += count;
                        return { bytesRead: count };
                    },
                    close: async () => {
                        closed++;
                    }
                };
            };
            assert.strictEqual((await inspectElf(file)).size, MAX_ELF_BYTES);
            total++;
            await assert.rejects(inspectElf(file), { code: "ELF_TOO_LARGE" });
            total = data.length;
            reported = total + 1;
            await assert.rejects(inspectElf(file), { code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION" });
            reported = total;
            modified = true;
            await assert.rejects(inspectElf(file), { code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION" });
            assert.strictEqual(closed, 4);
        } finally {
            fs.open = originalOpen;
        }

        const coordinator = new ProbeCoordinator();
        let calls = 0,
            runs = 0,
            busy = false,
            compatible = true,
            exitCode = 0,
            lastSnapshot;
        const executable = process.execPath;
        const service = new AgentFlashService({
            getConfig: () => ({ openocdPath: executable }),
            coordinator,
            authorization: new FlashAuthorization(),
            isDebugActive: () => busy,
            resolveLaunch: (value) => ({ executable: value }),
            check: async () => {
                calls++;
                return { compatible, version: "test" };
            },
            prepare: async (request) => {
                calls++;
                assert.strictEqual(request.injected, undefined);
                return request;
            },
            run: async (options) => {
                runs++;
                const commands = options.buildCommands().join(" ");
                lastSnapshot = commands.match(/(?:program|verify_image)\s+"([^"]+)"/)?.[1];
                assert(lastSnapshot, commands);
                assert.deepStrictEqual(await fs.readFile(lastSnapshot), data);
                options.onLine("EP_VERIFY OK");
                return { exitCode, openocdTail: [], commands: options.buildCommands() };
            }
        });
        const params = {
            elf: file,
            elfSha256: digest,
            probe: "p.cfg",
            target: "t.cfg",
            openocd: executable,
            injected: "ignored"
        };
        const verify = async (options = params) => {
            const authorization = await service.authorize({ ...options, operation: "flash.verify" });
            return service.execute({ ...options, confirmationId: authorization.confirmationId }, true);
        };
        for (const key of ["openocd", "executable"])
            for (const method of [
                () => service.authorize({ ...params, [key]: path.join(root, "other.exe") }),
                () => service.execute({ ...params, [key]: path.join(root, "other.exe") }),
                () => service.execute({ ...params, [key]: path.join(root, "other.exe") }, true)
            ])
                await assert.rejects(method(), { code: "OPENOCD_EXECUTABLE_MISMATCH" });
        assert.strictEqual(calls, 0, "no subprocess or preflight may run on mismatch");
        busy = true;
        await assert.rejects(service.execute(params, true), { code: "PROBE_BUSY" });
        busy = false;
        await assert.rejects(service.execute(params), /confirmation/);
        await assert.rejects(service.authorize({ ...params, elfSha256: "wrong" }), {
            code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION"
        });
        const authorized = await service.authorize({
            ...params,
            executable: path.join(path.dirname(executable), ".", path.basename(executable))
        });
        assert(authorized.confirmationRequired);
        assert((await service.execute({ ...params, confirmationId: authorized.confirmationId })).verified);
        await assert.rejects(fs.stat(lastSnapshot), { code: "ENOENT" });
        await assert.rejects(service.execute({ ...params, confirmationId: authorized.confirmationId }), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
        assert((await verify()).verified);
        exitCode = 1;
        assert.strictEqual((await verify()).verified, false);
        compatible = false;
        await assert.rejects(service.execute({ ...params, confirmationId: "pending" }, true), /Incompatible/);
        assert.strictEqual(coordinator.anyActive(), false);
        assert.strictEqual(runs, 3);
        compatible = true;
        const originalPrepare = service.prepare;
        await assert.rejects(service.execute(params, true), /Flash verification confirmation is required/);
        const requestedVerify = await service.authorize({ ...params, operation: "flash.verify" });
        assert(requestedVerify.confirmationRequired);
        assert.strictEqual(runs, 3, "verification must not halt the target before chat confirmation");
        await assert.rejects(service.execute({ ...params, confirmationId: "unknown" }, true), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
        await assert.rejects(service.execute({ ...params, confirmationId: requestedVerify.confirmationId }), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
        const changedConnection = await service.authorize({ ...params, operation: "flash.verify" });
        service.prepare = async (request) => ({ ...request, probeSerial: "changed" });
        await assert.rejects(service.execute({ ...params, confirmationId: changedConnection.confirmationId }, true), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
        assert.strictEqual(runs, 3, "unconfirmed or changed plans must not reach hardware");
        service.prepare = originalPrepare;
        await verify();
        service.run = async (options) => {
            options.onLine("EP_VERIFY FAIL mismatch");
            return { exitCode: 0, openocdTail: [] };
        };
        assert.strictEqual((await verify()).verified, false);
        service.prepare = async () => {
            busy = true;
            return params;
        };
        await assert.rejects(service.execute({ ...params, confirmationId: "pending" }, true), { code: "PROBE_BUSY" });
        busy = false;
        assert.strictEqual(coordinator.anyActive(), false);
        // Snapshot creation and subprocess cancellation both release the lease
        // and remove the private directory, including partially written files.
        const makeTemporary = fs.mkdtemp;
        const openFile = fs.open;
        let temporary;
        fs.mkdtemp = async (...args) => (temporary = await makeTemporary(...args));
        try {
            fs.open = async (name, ...args) => {
                if (String(name).endsWith("firmware.elf")) throw new Error("snapshot creation failed");
                return openFile(name, ...args);
            };
            await assert.rejects(
                service.execute({ ...params, confirmationId: "pending" }, true),
                /snapshot creation failed/
            );
            await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
            assert.strictEqual(coordinator.anyActive(), false);
            fs.open = openFile;
            service.prepare = async (request) => request;
            service.run = async () => {
                throw new Error("cancelled");
            };
            await assert.rejects(verify(), /cancelled/);
            await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
            assert.strictEqual(coordinator.anyActive(), false);
        } finally {
            fs.open = openFile;
            fs.mkdtemp = makeTemporary;
        }
        service.getConfig = () => ({ openocdPath: "" });
        await assert.rejects(service.authorize(params), /Configure OpenOCD/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    await scenario("Hold probe ownership and verify approved flash images", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-ownership-"));
        let running;
        let release;
        try {
            const elf = path.join(root, "firmware.elf");
            await fs.writeFile(elf, minimalElf());
            const params = {
                elf,
                elfSha256: crypto.createHash("sha256").update(minimalElf()).digest("hex"),
                target: "t.cfg",
                probe: "p.cfg",
                openocd: require("../src/openocdScripts").resolveExecutablePath("openocd")
            };
            const coordinator = new ProbeCoordinator();
            const authorization = new FlashAuthorization();
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            let entered;
            const started = new Promise((resolve) => {
                entered = resolve;
            });
            const service = new AgentFlashService({
                getConfig: () => ({ openocdPath: "openocd" }),
                coordinator,
                authorization,
                isDebugActive: () => false,
                resolveLaunch: () => ({ executable: "openocd" }),
                check: async () => ({ compatible: true }),
                prepare: async (params) => params,
                run: async (options) => {
                    const commands = options.buildCommands().join(" ");
                    assert(commands.includes("verify_image"));
                    // 校验前将 work-area 置 0，促使 OpenOCD 回退到主机侧分块比对。
                    assert(commands.includes("-work-area-size 0"));
                    entered();
                    await gate;
                    return { exitCode: 0, openocdTail: ["EP_VERIFY OK"] };
                }
            });
            const active = coordinator.acquire("liveWatch");
            try {
                await assert.rejects(service.execute(params, true), (error) => error.code === "PROBE_BUSY");
            } finally {
                active.release();
            }
            await assert.rejects(
                service.execute({ ...params, elfSha256: "changed", confirmationId: "pending" }, true),
                /ELF changed/
            );
            await assert.rejects(service.execute(params), /confirmation/);
            await assert.rejects(service.execute(params, true), /confirmation/);
            const verification = await service.authorize({ ...params, operation: "flash.verify" });
            assert(verification.confirmationRequired);
            running = service.execute({ ...params, confirmationId: verification.confirmationId }, true);
            await Promise.race([started, running]);
            assert.throws(
                () => coordinator.acquire("chipInfo"),
                (error) => error.code === "PROBE_BUSY"
            );
            release();
            assert.strictEqual((await running).verified, true);
            assert.strictEqual(coordinator.anyActive(), false);
            params.confirmationId = authorization.authorize({
                elf: { path: await fs.realpath(elf), sha256: params.elfSha256 },
                target: params.target,
                probe: params.probe,
                openocd: params.openocd
            }).confirmationId;
            service.run = async (options) => {
                const commands = options.buildCommands().join(" ");
                assert(commands.includes("program"));
                // program 自带 verify 与 reset；work-area backup 保护被用作缓冲区的目标 RAM。
                assert(commands.includes("verify reset exit"));
                assert(commands.includes("-work-area-backup 1"));
                for (const line of [
                    "Info : Reduced speed from 15000 kHz to 12000 kHz (maximum).",
                    "EP_FLASH_SPEED=15000",
                    "EP_FLASH_STAGE=speed_fallback"
                ])
                    options.onLine(line);
                return { exitCode: 0, openocdTail: [] };
            };
            const flashed = await service.execute(params);
            assert.strictEqual(flashed.verified, true);
            assert.deepStrictEqual(flashed.programming, {
                unchanged: false,
                flashClockKhz: 12000,
                speedFallback: true
            });
            await assert.rejects(service.execute(params), /invalid/);
        } finally {
            release?.();
            await running?.catch(() => {});
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    console.log("Flash executable policy and bounded ELF tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
