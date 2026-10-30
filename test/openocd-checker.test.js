"use strict";
const assert = require("assert");
const path = require("path");
const checker = require("../src/openocdChecker");
const {
    parseVersion,
    compareVersions,
    checkCompatibility,
    isCompatibleResult,
    incompatibleStatus,
    probeOpenOcd,
    getCachedResult,
    setCache,
    resetCache,
    persistOpenOcdPath,
    resolveOpenOcdStatus,
    MIN_OPENOCD_VERSION
} = checker;

(async () => {
    // Version parsing: standard format and development builds with an -rc2 suffix
    assert.strictEqual(parseVersion("Open On-Chip Debugger 0.12.0"), "0.12.0");
    assert.strictEqual(parseVersion("Open On-Chip Debugger 0.11.0-rc2 (2021-09-30)"), "0.11.0-rc2");
    assert.strictEqual(parseVersion("some unrelated text"), "");
    assert.strictEqual(parseVersion(""), "");
    assert.strictEqual(MIN_OPENOCD_VERSION, "0.12.0");
    assert.strictEqual(compareVersions("0.11.0", MIN_OPENOCD_VERSION), -1);
    assert.strictEqual(compareVersions("0.12", MIN_OPENOCD_VERSION), 0);
    assert.strictEqual(compareVersions("0.13.0", MIN_OPENOCD_VERSION), 1);
    assert.strictEqual(compareVersions("vendor-build", MIN_OPENOCD_VERSION), null);
    assert.strictEqual(checkCompatibility("0.11.0").compatible, false);
    assert.strictEqual(checkCompatibility("0.12.0-rc2").compatible, false);
    assert.strictEqual(checkCompatibility("0.12.0").compatible, true);
    assert.strictEqual(checkCompatibility("0.12.0-7").compatible, true, "xPack packaging revisions are compatible");
    assert.strictEqual(checkCompatibility("1.0.0").compatible, true);
    assert.strictEqual(checkCompatibility("").reason, "unknown");
    assert.strictEqual(isCompatibleResult({ found: true, version: "0.12.0" }), true);
    assert.strictEqual(isCompatibleResult({ found: true, version: "0.11.0" }), false);
    assert.strictEqual(incompatibleStatus({ found: true, version: "0.11.0" }).key, "oc.incompatibleUpgrade");
    assert.strictEqual(incompatibleStatus({ found: true, version: "" }).key, "oc.versionUnknownUpgrade");

    // An empty path is not found, without spawning
    const empty = await probeOpenOcd("");
    assert.strictEqual(empty.found, false);
    assert.strictEqual(empty.path, "");
    assert.ok(empty.error, "an empty path gives a reason");

    // A missing executable is not found (ENOENT) and gets a readable error
    const missing = await probeOpenOcd("this-binary-does-not-exist-xyz-98765");
    assert.strictEqual(missing.found, false);
    assert.strictEqual(missing.path, "this-binary-does-not-exist-xyz-98765");
    assert.ok(missing.error, "a missing executable gives a readable error");

    // Probing a command that certainly exists (node itself): it is not OpenOCD, so found=false
    const nodePath = process.execPath;
    const fakeResult = await probeOpenOcd(nodePath);
    // node --version output lacks "open on-chip debugger", so it must count as not found
    assert.strictEqual(fakeResult.found, false, "a non-OpenOCD executable is not reported as ready");
    assert.strictEqual(fakeResult.path, nodePath);

    // Cache read/write round trip
    resetCache();
    assert.strictEqual(getCachedResult(), null);
    setCache({ found: true, path: "/x/openocd", version: "0.12.0", error: "" });
    const cached = getCachedResult();
    assert.strictEqual(cached.found, true);
    assert.strictEqual(cached.version, "0.12.0");
    assert.strictEqual(cached.compatible, true);
    resetCache();
    assert.strictEqual(getCachedResult(), null);

    // With a workspace open, write the Workspace setting and override Folder settings still pointing at the old path;
    // Folder settings customized to other values are left alone.
    const updates = [];
    const folders = [{ uri: { id: "a" } }, { uri: { id: "b" } }];
    const vscodeMock = {
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: {
            workspaceFolders: folders,
            getConfiguration: (_section, uri) => ({
                inspect: () =>
                    uri?.id === "a"
                        ? { workspaceFolderValue: "old-openocd" }
                        : { workspaceFolderValue: "custom-openocd" },
                update: (key, value, target) => {
                    updates.push({ uri: uri?.id || "", key, value, target });
                }
            })
        },
        window: {
            showWarningMessage: () => {
                throw new Error("OpenOCD 缺失不得弹出通知");
            },
            showInformationMessage: () => {
                throw new Error("OpenOCD 状态不得弹出通知");
            }
        }
    };
    await persistOpenOcdPath(vscodeMock, "new-openocd", "old-openocd");
    assert.deepStrictEqual(updates, [
        { uri: "", key: "openocdPath", value: "new-openocd", target: 2 },
        { uri: "a", key: "openocdPath", value: "new-openocd", target: 3 }
    ]);

    // Passing an existing probe result to the bootstrap function returns the final path without starting another probe
    // process.
    const reported = [];
    const readyPath = await resolveOpenOcdStatus(
        "ready-openocd",
        null,
        {
            found: true,
            path: "ready-openocd",
            version: "0.12.0",
            error: ""
        },
        (status) => reported.push(status)
    );
    assert.strictEqual(readyPath, "ready-openocd");
    assert.strictEqual(reported.at(-1).state, "ready");

    const missingContext = { asAbsolutePath: () => path.join(__dirname, "missing-openocd-archive.tar.gz") };
    const missingPath = await resolveOpenOcdStatus(
        "missing-openocd",
        missingContext,
        {
            found: false,
            path: "missing-openocd",
            version: "",
            error: "找不到该可执行文件"
        },
        (status) => reported.push(status)
    );
    assert.strictEqual(missingPath, null);
    assert.strictEqual(reported.at(-1).state, "missing");
    assert.strictEqual(Object.hasOwn(reported.at(-1), "canInstall"), false);

    const incompatiblePath = await resolveOpenOcdStatus(
        "old-openocd",
        missingContext,
        {
            found: true,
            path: "old-openocd",
            version: "0.11.0",
            error: ""
        },
        (status) => reported.push(status)
    );
    assert.strictEqual(incompatiblePath, null);
    assert.strictEqual(reported.at(-1).state, "incompatible");
    assert.strictEqual(reported.at(-1).key, "oc.incompatibleUpgrade");

    console.log("OpenOCD checker tests passed");
})();
