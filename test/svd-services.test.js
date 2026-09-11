"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const yazl = require("yazl");
const {
    DeviceIdentityService,
    extractProjectParts,
    targetIdentity,
    scanProject
} = require("../src/services/deviceIdentityService");
const { SvdLibraryService, validateSvdBuffer } = require("../src/services/svdLibraryService");
const {
    OfficialSvdService,
    collectDevices,
    collectLicenses,
    latestRelease,
    parseXml,
    parseIndex,
    requestBuffer,
    requestFile,
    extractPackEntry,
    safeZipName,
    deviceMatches,
    vendorMatches,
    packageScore
} = require("../src/services/officialSvdService");

const VALID_SVD = Buffer.from(
    `<?xml version="1.0"?><device><name>STM32F40x</name><vendor>STMicroelectronics</vendor><version>1.0</version><peripherals><peripheral><name>GPIOA</name><baseAddress>0x40020000</baseAddress><registers><register><name>MODER</name><addressOffset>0</addressOffset><size>32</size></register></registers></peripheral></peripherals></device>`
);

function zipBuffer(entries) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        const chunks = [];
        zip.outputStream.on("data", (chunk) => chunks.push(chunk));
        zip.outputStream.on("error", reject);
        zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
        for (const [name, value] of entries) {
            if (value === null) zip.addEmptyDirectory(name);
            else zip.addBuffer(Buffer.from(value), name);
        }
        zip.end();
    });
}

(async () => {
    assert.deepStrictEqual(extractProjectParts("Mcu.Name=STM32F407VGT6\ndevice: STM32F407VG").slice(0, 2), [
        "STM32F407VGT6",
        "STM32F407VG"
    ]);
    assert.strictEqual(targetIdentity("stm32f4x.cfg").family, "STM32F4XX");

    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-identity-"));
    await fs.promises.writeFile(path.join(workspace, "board.ioc"), "Mcu.Name=STM32F407VGT6\n");
    const boundedScan = path.join(workspace, "bounded-scan");
    await fs.promises.mkdir(boundedScan);
    for (let index = 0; index < 10; index += 1)
        await fs.promises.writeFile(path.join(boundedScan, `board-${index}.yaml`), "device: STM32F407VG\n");
    assert.strictEqual(
        scanProject(boundedScan, 80, 3).length,
        3,
        "project identity scanning must stop at the visited-entry budget"
    );
    await fs.promises.rm(boundedScan, { recursive: true, force: true });
    const identity = new DeviceIdentityService().resolve({ workspacePath: workspace, target: "stm32f4x.cfg" });
    assert.strictEqual(identity.device, "STM32F407VGT6");
    assert.strictEqual(identity.exact, true);
    assert.strictEqual(identity.vendor, "STMicroelectronics");
    const compatibleIdentity = new DeviceIdentityService().resolve({
        target: "stm32f4x.cfg",
        chipInfo: { chip: "GD32F407VG", authenticity: "compatible", compatVendor: "GigaDevice" }
    });
    assert.strictEqual(compatibleIdentity.vendor, "GigaDevice");
    assert.strictEqual(compatibleIdentity.compatible, true);
    assert.strictEqual(
        new DeviceIdentityService().resolve({
            target: "nordic/nrf52.cfg",
            chipInfo: { deviceId: "0x1234", core: "Cortex-M4" }
        }).confidence,
        "fingerprint"
    );

    const parsedSvd = validateSvdBuffer(VALID_SVD, { device: "STM32F407VG", vendor: "STMicroelectronics" });
    assert.strictEqual(parsedSvd.device, "STM32F40x");
    assert.throws(
        () => validateSvdBuffer(Buffer.from("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><device/>")),
        (error) => error.code === "UNSAFE_XML"
    );
    assert.throws(
        () => validateSvdBuffer(VALID_SVD, { device: "GD32F407VG", vendor: "GigaDevice" }),
        (error) => /MISMATCH/.test(error.code)
    );
    assert.throws(
        () => validateSvdBuffer(VALID_SVD, { device: "STM32F407VG", vendor: "GigaDevice" }),
        (error) => error.code === "SVD_VENDOR_MISMATCH"
    );

    const storage = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-library-"));
    const state = {};
    const context = {
        globalStorageUri: { fsPath: storage },
        globalState: {
            get(key) {
                return state[key];
            },
            async update(key, value) {
                state[key] = value;
            }
        }
    };
    const source = path.join(storage, "source.svd");
    await fs.promises.writeFile(source, VALID_SVD);
    const library = new SvdLibraryService({ context });
    const first = await library.importFile(
        source,
        { source: "test" },
        { device: "STM32F407VG", vendor: "STMicroelectronics" }
    );
    const second = await library.importFile(source, { source: "test-again" });
    assert.strictEqual(first.hash, second.hash, "identical SVD files must deduplicate");
    const folderA = { toString: () => "file:///a" },
        folderB = { toString: () => "file:///b" };
    await library.bind(folderA, first.hash);
    await library.bind(folderB, first.hash);
    assert.strictEqual((await library.resolveBound(folderA)).path, (await library.resolveBound(folderB)).path);
    assert.strictEqual(await library.resolveBound({ toString: () => "file:///unbound" }), null);
    assert((await library.findCompatible({ device: "STM32F407VG", vendor: "STMicroelectronics" })).length === 1);

    const cached = await library.resolveBound(folderA, null, { readOnly: true });
    assert.strictEqual((await library.resolveBound(folderA, null, { readOnly: true })).svd, cached.svd);
    await fs.promises.writeFile(first.path, "broken XML");
    assert.strictEqual(await library.resolveBound(folderA, null, { readOnly: true }), null);
    assert.strictEqual(library.bindings()[folderA.toString()], first.hash);
    await fs.promises.writeFile(first.path, VALID_SVD);

    const hierarchy = parseXml(
        Buffer.from(
            `<package><vendor>Keil</vendor><devices><family Dfamily="STM32F4" Dvendor="STMicroelectronics"><debug svd="SVD/STM32F40x.svd" Pname="CM4"/><subFamily DsubFamily="STM32F407"><device Dname="STM32F407VG"/></subFamily></family></devices></package>`
        ),
        "test PDSC"
    ).package;
    const devices = collectDevices(hierarchy);
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].device, "STM32F407VG");
    assert.strictEqual(devices[0].svd, "SVD/STM32F40x.svd");
    assert.strictEqual(devices[0].core, "CM4");
    assert.strictEqual(
        collectLicenses(
            parseXml(
                Buffer.from(
                    `<package><licenseSets><licenseSet gating="true"><license title="A" spdx="MIT"/></licenseSet></licenseSets></package>`
                ),
                "license"
            ).package
        ).gating,
        true
    );
    assert.strictEqual(collectLicenses({ license: "LICENSE.txt" }).items[0].name, "LICENSE.txt");
    assert.strictEqual(
        latestRelease(
            parseXml(
                Buffer.from(
                    `<package><releases><release version="1.0.0-beta"/><release version="1.0.1"/></releases></package>`
                ),
                "release"
            ).package,
            "0.0.1"
        ).version,
        "1.0.1"
    );
    assert.strictEqual(latestRelease({}, "2.0.0").version, "2.0.0");
    assert.strictEqual(
        parseIndex(
            Buffer.from(
                `<index><url>https://example.invalid/</url><pindex><pdsc vendor="A" name="B_DFP" version="1.0.0"/><pdsc vendor="Old" name="Old" version="1.0.0" deprecated="yes"/></pindex></index>`
            )
        ).length,
        1
    );
    assert.throws(
        () => safeZipName("../escape.svd"),
        (error) => error.code === "UNSAFE_PACK_PATH"
    );
    assert.throws(
        () => safeZipName("/absolute.svd"),
        (error) => error.code === "UNSAFE_PACK_PATH"
    );
    assert.strictEqual(safeZipName("SVD/"), "SVD/");
    assert.throws(
        () => safeZipName("SVD//device.svd"),
        (error) => error.code === "UNSAFE_PACK_PATH"
    );
    assert.strictEqual(deviceMatches({ device: "STM32F407VG", family: "STM32F4" }, { family: "STM32F4XX" }), true);
    assert.strictEqual(vendorMatches({ vendor: "STMicroelectronics:13" }, { vendor: "STMicroelectronics" }), true);
    assert.strictEqual(vendorMatches({ vendor: "GigaDevice" }, { vendor: "STMicroelectronics" }), false);
    assert.strictEqual(vendorMatches({ vendor: "" }, { vendor: "STMicroelectronics" }), true);
    assert(
        packageScore(
            { name: "STM32F4xx_DFP", vendor: "Keil" },
            { device: "STM32F407VG", vendor: "STMicroelectronics" }
        ) >= 20
    );

    const pack = await zipBuffer([
        ["SVD/", null],
        ["SVD/STM32F40x.svd", VALID_SVD],
        ["LICENSE.txt", "test license"]
    ]);
    let baseUrl = "";
    const server = http.createServer((req, res) => {
        if (req.url === "/index.pidx") {
            const body = `<index><url>${baseUrl}/</url><pindex><pdsc url="${baseUrl}/" vendor="Keil" name="STM32F4xx_DFP" version="1.2.3"/></pindex></index>`;
            res.setHeader("Content-Type", "application/xml");
            res.end(body);
            return;
        }
        if (req.url === "/cancel-index.pidx") {
            const body = `<index><url>${baseUrl}/</url><pindex><pdsc url="${baseUrl}/" vendor="Keil" name="STM32F4_CANCEL_DFP" version="1.0.0"/></pindex></index>`;
            res.setHeader("Content-Type", "application/xml");
            res.end(body);
            return;
        }
        if (req.url === "/Keil.STM32F4xx_DFP.pdsc") {
            const body = `<package><vendor>Keil</vendor><name>STM32F4xx_DFP</name><url>${baseUrl}/</url><license>LICENSE.txt</license><releases><release version="1.2.3"/><release version="2.0.0-beta"/></releases><devices><family Dfamily="STM32F4" Dvendor="STMicroelectronics"><debug svd="SVD/STM32F40x.svd" Pname="CM4"/><device Dname="STM32F407VG"/></family></devices></package>`;
            res.setHeader("Content-Type", "application/xml");
            res.end(body);
            return;
        }
        if (req.url === "/Keil.STM32F4xx_DFP.1.2.3.pack") {
            res.setHeader("Content-Length", String(pack.length));
            res.end(pack);
            return;
        }
        if (req.url === "/truncated") {
            res.setHeader("Content-Length", "10000");
            res.write("partial");
            setImmediate(() => res.destroy());
            return;
        }
        if (req.url === "/slow") {
            res.setHeader("Content-Type", "application/octet-stream");
            const timer = setInterval(() => res.write(Buffer.alloc(1024)), 10);
            req.on("close", () => clearInterval(timer));
            return;
        }
        if (req.url === "/Keil.STM32F4_CANCEL_DFP.pdsc") {
            res.setHeader("Content-Type", "application/xml");
            const timer = setInterval(() => res.write(" "), 10);
            req.on("close", () => clearInterval(timer));
            return;
        }
        if (req.url === "/redirect") {
            res.statusCode = 302;
            res.setHeader("Location", "/index.pidx");
            res.end();
            return;
        }
        if (req.url === "/too-large") {
            res.setHeader("Content-Length", "999999");
            res.end("x");
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const progress = [];
        const official = new OfficialSvdService({
            indexUrl: `${baseUrl}/index.pidx`,
            allowHttpLocalhost: true,
            timeoutMs: 2000
        });
        const candidates = await official.discover(
            { device: "STM32F407VG", vendor: "STMicroelectronics", exact: true },
            { onProgress: (item) => progress.push(item) }
        );
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].packageVersion, "1.2.3", "pre-release packs must not be selected as stable");
        const downloaded = await official.download(candidates[0], { onProgress: (item) => progress.push(item) });
        assert.deepStrictEqual(downloaded.buffer, VALID_SVD);
        assert(progress.some((item) => Number.isFinite(item.percent)));
        assert((await requestBuffer(`${baseUrl}/redirect`, { allowHttpLocalhost: true })).buffer.length > 0);
        await assert.rejects(
            requestBuffer(`${baseUrl}/missing`, { allowHttpLocalhost: true }),
            (error) => error.code === "HTTP_ERROR"
        );
        await assert.rejects(
            requestBuffer(`${baseUrl}/too-large`, { allowHttpLocalhost: true, maxBytes: 10 }),
            (error) => error.code === "DOWNLOAD_TOO_LARGE"
        );

        const redirectedFile = path.join(storage, "redirected.xml");
        assert((await requestFile(`${baseUrl}/redirect`, redirectedFile, { allowHttpLocalhost: true })).received > 0);
        await assert.rejects(
            requestFile(`${baseUrl}/missing`, path.join(storage, "missing.bin"), { allowHttpLocalhost: true }),
            (error) => error.code === "HTTP_ERROR"
        );
        await assert.rejects(
            requestFile(`${baseUrl}/too-large`, path.join(storage, "large.bin"), {
                allowHttpLocalhost: true,
                maxBytes: 10
            }),
            (error) => error.code === "DOWNLOAD_TOO_LARGE"
        );

        const truncatedPath = path.join(storage, "truncated.pack");
        await assert.rejects(requestFile(baseUrl + "/truncated", truncatedPath, { allowHttpLocalhost: true }));
        await fs.promises.rm(truncatedPath, { force: true });
        await assert.rejects(requestFile(baseUrl + "/slow", storage, { allowHttpLocalhost: true }));
        await assert.rejects(
            requestFile(baseUrl + "/slow", path.join(storage, "overflow.pack"), {
                allowHttpLocalhost: true,
                maxBytes: 1025
            }),
            (error) => error.code === "DOWNLOAD_TOO_LARGE"
        );
        await fs.promises.rm(path.join(storage, "overflow.pack"));

        const packPath = path.join(storage, "test.pack");
        await fs.promises.writeFile(packPath, pack);
        await assert.rejects(
            extractPackEntry(packPath, "SVD/missing.svd"),
            (error) => error.code === "SVD_NOT_IN_PACK"
        );

        const abort = new AbortController();
        const pending = requestBuffer(`${baseUrl}/slow`, {
            allowHttpLocalhost: true,
            signal: abort.signal,
            maxBytes: 1024 * 1024
        });
        setTimeout(() => abort.abort(), 30);
        await assert.rejects(pending, (error) => error.code === "DOWNLOAD_CANCELLED");
        const fileAbort = new AbortController();
        const filePending = requestFile(`${baseUrl}/slow`, path.join(storage, "cancelled.pack"), {
            allowHttpLocalhost: true,
            signal: fileAbort.signal,
            maxBytes: 1024 * 1024
        });
        setTimeout(() => fileAbort.abort(), 30);
        await assert.rejects(filePending, (error) => error.code === "DOWNLOAD_CANCELLED");
        const discoverAbort = new AbortController();
        const discoverPending = new OfficialSvdService({
            indexUrl: `${baseUrl}/cancel-index.pidx`,
            allowHttpLocalhost: true,
            timeoutMs: 2000
        }).discover(
            { device: "STM32F407VG", vendor: "STMicroelectronics", exact: true },
            { signal: discoverAbort.signal }
        );
        setTimeout(() => discoverAbort.abort(), 30);
        await assert.rejects(
            discoverPending,
            (error) => error.code === "DOWNLOAD_CANCELLED",
            "catalog/PDSC cancellation must not be swallowed and retried"
        );
        assert.throws(
            () => requestBuffer("http://example.com/file", {}),
            (error) => error.code === "INSECURE_SOURCE"
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.promises.rm(workspace, { recursive: true, force: true });
        await fs.promises.rm(storage, { recursive: true, force: true });
    }
    console.log("SVD service tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
