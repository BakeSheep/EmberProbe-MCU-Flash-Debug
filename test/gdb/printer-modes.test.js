"use strict";

// Opt-in native Python-printer acceptance; normal tests require no compiler or GDB.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { MiClient, quote } = require("../../src/debug/mi");
const { EmberDebugSession } = require("../../src/debug/session");
const { initializePrettyPrinting } = require("../../src/services/prettyPrinting");

(async () => {
    const outputRoot = path.resolve(__dirname, "../../test-results");
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, "printer-native-"));
    const executable = path.join(root, process.platform === "win32" ? "printers.exe" : "printers");
    const script = path.join(root, "explicit printer's.py");
    fs.copyFileSync(path.resolve(__dirname, "../fixtures/gdb-printers.py"), script);
    const failingScript = path.join(root, "failing-printer.py");
    fs.writeFileSync(failingScript, 'raise RuntimeError("fixture initialization failed")\n');
    const compiler = process.env.CPP_CXX || "g++",
        gdb = process.env.CPP_GDB || "gdb";
    execFileSync(
        compiler,
        ["-std=c++17", "-g", "-O0", path.resolve(__dirname, "../fixtures/cpp-printers.cpp"), "-o", executable],
        { windowsHide: true }
    );
    try {
        for (const { mode, fail } of [
            { mode: "builtin" },
            { mode: "raw" },
            { mode: "gdb" },
            { mode: "gdb", fail: true }
        ]) {
            const mi = new MiClient();
            const adapter = new EmberDebugSession({ mi });
            const diagnostics = [];
            adapter.setRunAsServer(true);
            adapter.sendEvent = (event) => {
                if (event.event === "output") diagnostics.push(event.body.output);
            };
            adapter.config = { prettyPrintingMode: mode, prettyPrinterFiles: [fail ? failingScript : script] };
            try {
                mi.start(gdb, root);
                await mi.command("-gdb-set mi-async on");
                await mi.command("-gdb-set pagination off");
                await initializePrettyPrinting(mi, adapter.config, (message) => diagnostics.push(message));
                assert.strictEqual(
                    adapter.config.effectivePrettyPrintingMode,
                    fail ? "builtin" : mode,
                    diagnostics.join("")
                );
                await mi.command(`-file-exec-and-symbols ${quote(executable.replace(/\\/g, "/"))}`);
                await mi.command('-break-insert "printerCheckpoint"');
                adapter.ready = true;
                const stopped = new Promise((resolve) => {
                    const listener = (record) => {
                        if (record.kind === "*" && record.class === "stopped") {
                            mi.off("record", listener);
                            resolve(record);
                        }
                    };
                    mi.on("record", listener);
                });
                await mi.command("-exec-run");
                let timer;
                try {
                    await Promise.race([
                        stopped,
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error("Native printer stop timed out")), 10000);
                        })
                    ]);
                } finally {
                    clearTimeout(timer);
                }
                const evaluate = (expression) => adapter.handle("evaluate", { expression });
                const expand = (item) =>
                    adapter
                        .handle("variables", { variablesReference: item.variablesReference })
                        .then((response) => response.variables);
                const sample = await evaluate("sample");
                if (mode === "gdb" && !fail) {
                    assert.strictEqual(sample.result, "explicit sample printer");
                    const first = await expand(sample),
                        second = await expand(first.at(-1)),
                        third = await expand(second.at(-1));
                    assert.strictEqual(first[0].value, "0");
                    assert.strictEqual(second[0].value, "100");
                    assert.strictEqual(third.length, 5);
                    assert.strictEqual(third.at(-1).value, "204");
                    await adapter.handle("setVariable", {
                        variablesReference: sample.variablesReference,
                        name: first[0].name,
                        value: "7"
                    });
                    assert.strictEqual((await expand(sample))[0].value, "7");
                    const broken = await evaluate("broken");
                    const fields = await expand(broken);
                    const raw = fields.find((item) => item.name === "public")
                        ? await expand(fields.find((item) => item.name === "public"))
                        : fields;
                    assert.strictEqual(raw.find((item) => item.name === "rawField")?.value, "19", diagnostics.join(""));
                    assert(
                        diagnostics.some((message) => /Showing raw fields/.test(message)),
                        diagnostics.join("")
                    );
                } else {
                    assert(
                        !sample.result.includes("explicit sample"),
                        "configured scripts never run in builtin/raw modes"
                    );
                    const groups = await expand(sample);
                    assert(groups.some((item) => item.name === "public" || item.name === "values"));
                }
                if (fail) assert(diagnostics.some((message) => /initialization failed/.test(message)));
                console.log(
                    `Native GDB ${mode}${fail ? " initialization fallback" : ""}: explicit loading, bounded dynamic paging and raw fallback passed`
                );
            } catch (error) {
                fs.writeFileSync(
                    path.join(outputRoot, `printer-${mode}.log`),
                    diagnostics.join("") + "\n" + error.stack
                );
                throw error;
            } finally {
                const closed =
                    mi.process && mi.process.exitCode === null
                        ? new Promise((resolve) => mi.process.once("close", resolve))
                        : Promise.resolve();
                await mi.stop();
                await closed;
            }
        }
    } finally {
        assert(root.startsWith(outputRoot + path.sep));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
