"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vscode = require("vscode");
const { parseElfSections } = require("../../../../src/elfSymbols");

async function waitFor(predicate, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function verifyFlashImage(session, bytes, report) {
    const segments = parseElfSections(bytes).programHeaders.filter((segment) => segment.type === 1 && segment.filesz);
    let comparedBytes = 0;
    const deadline = Date.now() + 30000;
    for (const segment of segments) {
        assert.ok(segment.paddr >= 0x08000000 && segment.paddr + segment.filesz <= 0x08100000);
        assert.ok(comparedBytes + segment.filesz <= 1024 * 1024, "Firmware comparison byte budget");
        for (let offset = 0; offset < segment.filesz; offset += 4096) {
            assert.ok(Date.now() < deadline, "Firmware comparison time budget");
            const count = Math.min(4096, segment.filesz - offset);
            const result = await session.customRequest("readMemory", {
                memoryReference: `0x${(segment.paddr + offset).toString(16)}`,
                count
            });
            const actual = Buffer.from(result.data || "", "base64");
            const expected = bytes.subarray(segment.offset + offset, segment.offset + offset + count);
            assert.equal(actual.length, count);
            if (!actual.equals(expected))
                report.firmwareMismatch = {
                    address: `0x${(segment.paddr + offset).toString(16)}`,
                    expected: expected.subarray(0, 32).toString("hex"),
                    actual: actual.subarray(0, 32).toString("hex")
                };
            assert.ok(
                actual.equals(expected),
                `Existing firmware differs from ELF at 0x${(segment.paddr + offset).toString(16)}`
            );
            comparedBytes += count;
        }
    }
    assert.ok(comparedBytes > 0);
    return comparedBytes;
}

async function backupFlash(session, destination) {
    const bytes = Buffer.alloc(1024 * 1024);
    const deadline = Date.now() + 60000;
    for (let offset = 0; offset < bytes.length; offset += 4096) {
        assert.ok(Date.now() < deadline, "Flash backup time budget");
        const result = await session.customRequest("readMemory", {
            memoryReference: `0x${(0x08000000 + offset).toString(16)}`,
            count: 4096
        });
        const part = Buffer.from(result.data || "", "base64");
        assert.equal(part.length, 4096);
        part.copy(bytes, offset);
    }
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    return { path: destination, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

async function run() {
    const report = {
        time: new Date().toISOString(),
        platform: `${os.platform()} ${os.release()}`,
        checks: {},
        samples: {}
    };
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    const provider = (await extension.activate()).debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    const settings = vscode.workspace.getConfiguration("emberprobe");
    const elf = process.env.EMBERPROBE_HIL_ELF;
    const bytes = fs.readFileSync(elf);
    report.elf = { path: elf, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    report.probe = process.env.EMBERPROBE_HIL_PROBE;
    report.chipModel = process.env.EMBERPROBE_HIL_CHIP;
    let session;
    try {
        // Global settings and workspaceState belong to this disposable VS Code profile.
        await settings.update("probeRsPath", process.env.EMBERPROBE_HIL_PROBE_RS, vscode.ConfigurationTarget.Global);
        await settings.update("probeRsChip", "", vscode.ConfigurationTarget.Global);
        await settings.update("adapterSpeedKhz", 2000, vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider._refreshElfBindings();
        const parsed = await provider._elfService.ready();
        const items = [
            ["g_pid_balance_kp", "f32"],
            ["g_pid_balance_kd", "f32"],
            ["g_balance_debug_enable", "u32"],
            ["g_imu_init_attempts", "u32"],
            ["g_imu_init_stage", "u32"],
            ["g_imu_init_status", "u32"],
            ["xTickCount", "u32"]
        ].map(([name, type]) => {
            const symbol = parsed.symbols.find((candidate) => candidate.name === name);
            assert.ok(symbol, `Missing ${name} in the selected ELF`);
            return { name, address: symbol.address, size: 4, type };
        });
        await provider._saveWatchList("mcu.sidebarWatchList", items);
        const config = {
            name: "F407_car read-only audit validation",
            type: "emberprobe-probe-rs",
            request: "attach",
            chip: process.env.EMBERPROBE_HIL_CHIP,
            probe: process.env.EMBERPROBE_HIL_PROBE,
            speed: 2000,
            wireProtocol: "Swd",
            executable: elf,
            flashingConfig: { flashingEnabled: false }
        };
        const busyLease = provider._probeCoordinator.acquire("download");
        try {
            await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_BUSY" });
        } finally {
            busyLease.release();
        }
        assert.equal(await vscode.debug.startDebugging(folder, config), true);
        await waitFor(() => provider._debugBridge.runtimeProbeRs, "native F5 attach");
        session = provider._debugBridge.activeSession;
        report.adapterPid = provider._probeRsAdapters.get(session.id).process.pid;
        report.chipInfo = await provider.readChipInfoAction(true);
        try {
            report.checks.flashImageBytes = await verifyFlashImage(session, bytes, report);
        } catch (error) {
            if (report.firmwareMismatch && process.env.EMBERPROBE_HIL_BACKUP)
                report.flashBackup = await backupFlash(session, process.env.EMBERPROBE_HIL_BACKUP);
            throw error;
        }
        assert.equal(settings.get("probeRsChip"), "");
        assert.equal(report.chipInfo.core, "Cortex-M4");
        assert.equal(report.chipInfo.chip, config.chip);
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
        await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_BUSY" });
        assert.throws(() => provider._probeCoordinator.acquire("download"), { code: "PROBE_BUSY" });
        report.checks.launchChipAndOwnership = true;
        console.log("F407 HIL: matching flash image and session chip/ownership passed");

        await provider.startLiveWatch(undefined, 100, "sidebar", false);
        await waitFor(() => items.every((item) => provider._latestSidebarSamples.has(item.name)), "RAM samples");
        const firstTick = provider._latestSidebarSamples.get("xTickCount").value;
        await waitFor(
            () => provider._latestSidebarSamples.get("xTickCount").value > firstTick,
            "running FreeRTOS tick"
        );
        for (const item of items) report.samples[item.name] = provider._latestSidebarSamples.get(item.name).value;
        assert.equal(report.samples.g_balance_debug_enable, 0, "This test does not enable the motor control loop");
        const agentSamples = await provider._withAgentProbe(({ session: bridge }) => bridge.readOnce(items));
        assert.equal(agentSamples.length, items.length);
        report.checks.sidebarAndAgentRam = true;
        report.sampling = provider._debugBridge.stats();
        console.log("F407 HIL: actual running sidebar and Agent RAM samples passed");

        // Stop background polling without pausing the MCU. Instrument the transport
        // so a regression in a negative test cannot issue an unsafe hardware request.
        const bridge = provider._debugBridge;
        bridge.snapshotPending = false;
        await waitFor(() => !bridge.polling, "sampling idle");
        const originalRead = bridge._readBlock;
        const originalWrite = bridge.writeAndVerify;
        let rejectedTransportCalls = 0;
        bridge._readBlock = async () => {
            rejectedTransportCalls++;
            throw new Error("Negative test reached DAP read");
        };
        bridge.writeAndVerify = async () => {
            rejectedTransportCalls++;
            throw new Error("Negative test reached DAP write");
        };
        try {
            await assert.rejects(
                provider._withAgentProbe(({ session: reader }) =>
                    reader.readOnce([{ name: "MMIO", address: 0x40000000, size: 4 }])
                ),
                { code: "LIVE_ADDRESS_NOT_RAM" }
            );
            await provider._context.workspaceState.update("mcu.elfPath", elf + ".different");
            await assert.rejects(bridge.readOnce(items), { code: "DEBUG_ELF_SESSION_MISMATCH" });
            await assert.rejects(provider._writeUiVariable("g_pid_balance_kp", 0), {
                code: "DEBUG_ELF_SESSION_MISMATCH"
            });
            assert.equal(rejectedTransportCalls, 0);
            report.checks.runtimeMmioAndElfMismatch = true;
        } finally {
            bridge._readBlock = originalRead;
            bridge.writeAndVerify = originalWrite;
            await provider._context.workspaceState.update("mcu.elfPath", elf);
        }
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !bridge.hasAnySession, "confirmed adapter exit");
        assert.equal(provider._probeCoordinator.anyActive(), false);
        report.checks.confirmedExit = true;
        console.log("F407 HIL: ELF/MMIO rejection and first process exit passed");

        await settings.update("probeRsChip", config.chip, vscode.ConfigurationTarget.Global);
        await provider.startLiveWatch(undefined, 100, "sidebar");
        await waitFor(() => bridge.runtimeProbeRs, "automatic LiveWatch attach");
        assert.equal(bridge.activeSession.configuration.__emberprobeWatchOnly, true);
        assert.equal(await provider._startProbeRsDebug("attach", folder.uri, false, config), true);
        await waitFor(
            () => bridge.runtimeProbeRs && !bridge.activeSession.configuration.__emberprobeWatchOnly,
            "watch-to-debug replacement"
        );
        session = bridge.activeSession;
        assert.equal((await provider.readChipInfoAction(true)).cpuid, report.chipInfo.cpuid);
        report.checks.reattachAndWatchReplacement = true;
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !bridge.hasAnySession, "final exit");
        assert.equal(provider._probeCoordinator.anyActive(), false);
        report.ok = true;
        console.log(
            "✓ F407_car: existing flash image, native/automatic attach, RAM sampling, guards, chip info and process release"
        );
    } catch (error) {
        report.ok = false;
        report.error = error.stack || String(error);
        throw error;
    } finally {
        await provider.stopLiveWatch();
        session ||= provider._debugBridge.activeSession;
        if (session) await vscode.debug.stopDebugging(session);
        await Promise.all([...provider._probeRsAdapters.values()].map((adapter) => adapter.waitForExit(5000)));
        report.finalState = provider._debugBridge.agentStatus();
        report.finalLease = provider._probeCoordinator.snapshot();
        fs.mkdirSync(path.dirname(process.env.EMBERPROBE_HIL_REPORT), { recursive: true });
        fs.writeFileSync(process.env.EMBERPROBE_HIL_REPORT, JSON.stringify(report, null, 2));
    }
}

module.exports = { run };
