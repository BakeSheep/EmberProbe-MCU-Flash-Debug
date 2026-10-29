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

// 用 async IIFE 包裹 await，避免与 require 一起触发模块格式歧义
(async () => {
    // 版本号解析：兼容标准格式与带 -rc2 后缀的开发版
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

    // 空路径应直接判定为未找到，不触发 spawn
    const empty = await probeOpenOcd("");
    assert.strictEqual(empty.found, false);
    assert.strictEqual(empty.path, "");
    assert.ok(empty.error, "空路径应给出错误原因");

    // 不存在的可执行文件应判定为未找到（ENOENT），并给出可读错误
    const missing = await probeOpenOcd("this-binary-does-not-exist-xyz-98765");
    assert.strictEqual(missing.found, false);
    assert.strictEqual(missing.path, "this-binary-does-not-exist-xyz-98765");
    assert.ok(missing.error, "缺失时应给出可读错误");

    // 对一个一定存在的命令（node 自身）探测：它不是 OpenOCD，应识别为 found=false
    const nodePath = process.execPath;
    const fakeResult = await probeOpenOcd(nodePath);
    // node --version 输出不含 "open on-chip debugger"，必须判为未找到
    assert.strictEqual(fakeResult.found, false, "非 OpenOCD 可执行文件不应误判为已就绪");
    assert.strictEqual(fakeResult.path, nodePath);

    // 缓存读写一致性
    resetCache();
    assert.strictEqual(getCachedResult(), null);
    setCache({ found: true, path: "/x/openocd", version: "0.12.0", error: "" });
    const cached = getCachedResult();
    assert.strictEqual(cached.found, true);
    assert.strictEqual(cached.version, "0.12.0");
    assert.strictEqual(cached.compatible, true);
    resetCache();
    assert.strictEqual(getCachedResult(), null);

    // 打开工作区时写 Workspace，并覆盖仍指向旧路径的 Folder 设置；自定义为其他值的 Folder 不应被改写。
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

    // 已有探测结果传入引导函数时应直接返回最终路径，不再重复启动探测进程。
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
