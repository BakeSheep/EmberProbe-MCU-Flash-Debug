"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { SvdManager, findFiles } = require("../src/services/svdManager");

const SVD = Buffer.from(
    `<?xml version="1.0"?><device><name>STM32F40x</name><vendor>STMicroelectronics</vendor><peripherals><peripheral><name>GPIOA</name><baseAddress>0x40020000</baseAddress></peripheral></peripherals></device>`
);

(async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-manager-"));
    const workspacePath = path.join(root, "workspace");
    const storagePath = path.join(root, "storage");
    await fs.promises.mkdir(workspacePath);
    await fs.promises.mkdir(storagePath);
    const scanPath = path.join(root, "bounded-scan");
    await fs.promises.mkdir(scanPath);
    for (let index = 0; index < 10; index += 1)
        await fs.promises.writeFile(path.join(scanPath, `file-${index}.txt`), "x");
    let scanned = 0;
    findFiles(
        scanPath,
        () => {
            scanned += 1;
            return false;
        },
        100,
        3
    );
    assert.strictEqual(scanned, 3, "file discovery must stop at the visited-entry budget even without matches");
    const elf = path.join(workspacePath, "firmware.elf");
    const svd = path.join(workspacePath, "chip.svd");
    await fs.promises.writeFile(elf, "ELF");
    await fs.promises.writeFile(svd, SVD);
    await fs.promises.writeFile(path.join(workspacePath, "board.ioc"), "Mcu.Name=STM32F407VGT6\n");

    const folder = { name: "workspace", uri: { fsPath: workspacePath, toString: () => `file://${workspacePath}` } };
    const wsState = { elf, mcu: "stm32f4x.cfg" };
    const globalState = {};
    const quickPicks = [];
    const statuses = [];
    const messages = [];
    const reports = [];
    const Uri = {
        file(file) {
            return { fsPath: file, toString: () => `file://${file}` };
        }
    };
    const vscode = {
        Uri,
        ProgressLocation: { Notification: 15 },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder(uri) {
                return uri.fsPath.startsWith(workspacePath) ? folder : undefined;
            }
        },
        window: {
            async showOpenDialog() {
                return [{ fsPath: svd }];
            },
            async showQuickPick(items) {
                return quickPicks.length ? quickPicks.shift()(items) : items[0];
            },
            async showWarningMessage(message, options, accept) {
                messages.push(message);
                return accept;
            },
            async showInformationMessage(message) {
                messages.push(message);
            },
            async showErrorMessage(message) {
                messages.push(message);
            },
            async withProgress(options, task) {
                return task({ report: (value) => reports.push(value) }, { onCancellationRequested() {} });
            }
        }
    };
    const context = {
        globalStorageUri: { fsPath: storagePath },
        workspaceState: {
            get(key) {
                return wsState[key];
            },
            async update(key, value) {
                if (value === undefined) delete wsState[key];
                else wsState[key] = value;
            }
        },
        globalState: {
            get(key) {
                return globalState[key];
            },
            async update(key, value) {
                globalState[key] = value;
            }
        }
    };
    const candidate = {
        device: "STM32F407VG",
        family: "STM32F4",
        vendor: "STMicroelectronics",
        core: "CM4",
        svd: "SVD/STM32F40x.svd",
        pdscUrl: "https://example.invalid/Keil.STM32F4xx_DFP.pdsc",
        packageVendor: "Keil",
        packageName: "STM32F4xx_DFP",
        packageVersion: "2.0.0",
        license: { gating: true, items: [{ title: "Test", spdx: "MIT" }] }
    };
    const official = {
        async discover(_identity, options) {
            options.onProgress({ phase: "catalog", current: 1, total: 5, percent: 100 });
            return [candidate];
        },
        async download(selected, options) {
            assert.strictEqual(selected, candidate);
            options.onProgress({ phase: "downloading", received: 50, total: 100, percent: 50 });
            options.onProgress({ phase: "validating", percent: 100 });
            assert.strictEqual(
                await options.onLicense({ source: candidate.pdscUrl, licenses: candidate.license.items }),
                true
            );
            return { buffer: SVD, sourceUrl: "https://example.invalid/Keil.STM32F4xx_DFP.2.0.0.pack", candidate };
        }
    };
    const manager = new SvdManager({
        vscode,
        context,
        cacheKeys: { elfPath: "elf", mcuCore: "mcu", svdPath: "svd" },
        t: (key, params) => `${key}${params ? JSON.stringify(params) : ""}`,
        getChipInfo: () => ({ core: "Cortex-M4" }),
        onStatus: (status) => statuses.push(status),
        official
    });

    assert.strictEqual(manager.workspaceForElf(), folder);
    assert.strictEqual(manager.identityFor(folder).device, "STM32F407VGT6");
    const auto = await manager.resolveForFolder(folder);
    assert(auto?.path.includes("svd-library"));
    assert.strictEqual(await manager.currentPath(folder), auto.path);
    assert.strictEqual((await manager.selectExisting(folder)).hash, auto.hash);

    await manager.syncStatus(folder);
    assert(statuses.some((status) => status.state === "configured"));

    const downloaded = await manager.downloadOfficial(folder);
    assert(downloaded?.metadata?.packageVersion === "2.0.0");
    assert(statuses.some((status) => status.state === "downloading"));
    assert(statuses.some((status) => status.key === "svd.catalogProgress" && status.percent === null));
    assert(reports.some((report) => report.message.includes("svd.catalogProgress") && report.increment === undefined));
    assert.deepStrictEqual(
        reports.filter((report) => report.increment !== undefined).map((report) => report.increment),
        [50, 50],
        "metadata checks must not advance the Pack download percentage"
    );
    assert(messages.some((message) => message.includes("svd.configuredNextDebug")));

    quickPicks.push((items) => items.find((item) => item.entry));
    assert((await manager.switchBinding(folder)).hash);
    quickPicks.push((items) => items.find((item) => item.action === "clear"));
    assert.strictEqual(await manager.switchBinding(folder), true);
    assert(statuses.some((status) => status.state === "idle"));

    quickPicks.push((items) => items.find((item) => item.action === "select"));
    assert((await manager.switchBinding(folder)).hash);
    assert.strictEqual(manager.cancel(), false, "cancel should report when no download is active");

    const cancelling = new SvdManager({
        vscode,
        context,
        cacheKeys: { elfPath: "elf", mcuCore: "mcu", svdPath: "svd" },
        t: (key) => key,
        onStatus: (status) => statuses.push(status),
        official: {
            async discover(identity, options) {
                return new Promise((resolve, reject) =>
                    options.signal.addEventListener(
                        "abort",
                        () => reject(Object.assign(new Error("cancelled"), { code: "DOWNLOAD_CANCELLED" })),
                        { once: true }
                    )
                );
            }
        }
    });
    const cancelledDownload = cancelling.downloadOfficial(folder);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(cancelling.cancel(), true, "an active SVD operation should be cancellable from the sidebar");
    assert.strictEqual(await cancelledDownload, null);
    assert(
        statuses.some((status) => status.state === "cancelling"),
        "cancellation should immediately publish feedback"
    );
    assert(
        statuses.some((status) => status.key === "svd.cancelled"),
        "cancelled downloads should settle with a cancelled status"
    );

    const failing = new SvdManager({
        vscode,
        context,
        cacheKeys: { elfPath: "elf", mcuCore: "mcu", svdPath: "svd" },
        t: (key) => key,
        onStatus: (status) => statuses.push(status),
        official: {
            async discover() {
                throw Object.assign(new Error("network down"), { code: "TEST" });
            }
        }
    });
    await assert.rejects(failing.downloadOfficial(folder), { code: "TEST" });
    assert(statuses.some((status) => status.state === "error"));

    await fs.promises.rm(root, { recursive: true, force: true });
    console.log("SVD manager tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
