"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const i18n = require("../src/i18n");
const { EmberDebugSession } = require("../src/debug/session");
const { MiClient } = require("../src/debug/mi");
const { debugError, adapterLanguage, localizeError } = require("../src/debug/errors");

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
    // Keyed errors follow the sidebar's language, coded ones use their err.* text, and GDB's own stay as written.
    const paused = debugError("targetMustBePaused", "Target must be paused");
    assert.strictEqual(localizeError(paused, "zh"), i18n.t("zh", "dbg.targetMustBePaused"));
    assert.strictEqual(localizeError(paused, "en"), i18n.t("en", "dbg.targetMustBePaused"));
    const coded = Object.assign(new Error("RTOS task 7 no longer exists"), { code: "DEBUG_TASK_EXITED" });
    assert.strictEqual(localizeError(coded, "zh"), i18n.t("zh", "err.DEBUG_TASK_EXITED"));
    assert.strictEqual(
        localizeError(new Error('No symbol "foo" in current context.'), "zh"),
        'No symbol "foo" in current context.'
    );
    assert.strictEqual(
        localizeError(
            debugError("invalidImages", "loadImage.file is required", { detail: "loadImage.file is required" }),
            "zh"
        ),
        "调试配置中的映像设置无效：loadImage.file is required"
    );
    // Every keyed debugger message has both translations.
    for (const key of Object.keys(i18n.STRINGS.zh).filter((name) => name.startsWith("dbg.")))
        assert(i18n.STRINGS.en[key], `missing English text for ${key}`);

    // Without a configured language the adapter follows VS Code's display language.
    assert.strictEqual(adapterLanguage("en"), "en");
    assert.strictEqual(adapterLanguage("", { VSCODE_NLS_CONFIG: JSON.stringify({ locale: "zh-cn" }) }), "zh");
    assert.strictEqual(adapterLanguage("", { VSCODE_NLS_CONFIG: "{" }), i18n.DEFAULT_LANG);

    // A launch carries the sidebar's language into the error responses, and setLanguage follows a later switch.
    const adapter = new EmberDebugSession({
        mi: Object.assign(new EventEmitter(), { command: async () => ({}), stop: async () => {} })
    });
    adapter.setRunAsServer(true);
    const responses = [];
    adapter.sendEvent = () => {};
    adapter.sendResponse = (response) => responses.push(response);
    adapter.sendErrorResponse = (response, error) => responses.push({ ...response, success: false, error });
    adapter.close = async () => {};
    adapter.dispatchRequest({ seq: 1, command: "launch", arguments: { __emberprobeLanguage: "zh", executable: "" } });
    await adapter.queue;
    assert.deepStrictEqual([responses[0].success, responses[0].error.format], [false, i18n.t("zh", "dbg.elfRequired")]);
    assert.strictEqual(responses[0].error.showUser, true);
    adapter.dispatchRequest({ seq: 2, command: "emberprobe.setLanguage", arguments: { lang: "en" } });
    await adapter.queue;
    assert.strictEqual(adapter.lang, "en");

    // GDB output is read in whole lines, so a character split across chunks or quoted in the system code page
    // (GBK on Chinese Windows) arrives intact; MI strings decode the same way.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write() {} });
    const client = new MiClient({ spawn: () => child });
    const output = [];
    client.on("output", (text) => output.push(text));
    client.start("gdb", process.cwd());
    const text = Buffer.from("无法连接\n", "utf8");
    child.stderr.emit("data", text.subarray(0, 4));
    child.stderr.emit("data", text.subarray(4));
    child.stdout.emit("data", Buffer.from('~"\\324\\266\\263\\314"\n'));
    await tick();
    assert.deepStrictEqual(output.slice(0, 1), ["无法连接\n"]);
    if (process.platform === "win32" && /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale))
        assert.strictEqual(output[1], "远程");
    console.log("Debugger error localization and GDB output decoding passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
