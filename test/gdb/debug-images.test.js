"use strict";

// Opt-in real ARM GDB and BFD acceptance against a memory-only RSP target, never hardware.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { MiClient, quote } = require("../../src/debug/mi");
const { EmberDebugSession } = require("../../src/debug/session");
const { normalizeDebugImages } = require("../../src/services/debugImages");
const { FreeRtosSnapshot } = require("../../src/services/freeRtosSnapshot");
const { RspMemory } = require("./rsp-memory");

(async () => {
    const outputRoot = path.resolve(__dirname, "../../test-results");
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, "images-native-"));
    const compiler = process.env.IMAGE_CXX || "arm-none-eabi-g++";
    const gdb = process.env.IMAGE_GDB || "arm-none-eabi-gdb";
    const nm = process.env.IMAGE_NM || "arm-none-eabi-nm";
    const objcopy = process.env.IMAGE_OBJCOPY || "arm-none-eabi-objcopy";
    const primary = path.join(root, "primary.elf"),
        secondary = path.join(root, "secondary.elf");
    const hex = path.join(root, "flash.hex"),
        bin = path.join(root, "payload's.bin");
    const memory = new RspMemory();
    const mi = new MiClient();
    const adapter = new EmberDebugSession({ mi });
    const diagnostics = [];
    adapter.setRunAsServer(true);
    adapter.sendEvent = (event) => {
        if (event.event === "output") diagnostics.push(event.body.output);
    };
    try {
        for (const [name, output] of [
            ["primary", primary],
            ["secondary", secondary]
        ]) {
            execFileSync(
                compiler,
                [
                    "-g",
                    "-O0",
                    "-mcpu=cortex-m4",
                    "-mthumb",
                    "-nostdlib",
                    "-Wl,-Ttext=0x08000000,-Tdata=0x20000000,-e,imageCheckpoint",
                    path.resolve(__dirname, `../fixtures/images-${name}.cpp`),
                    "-o",
                    output
                ],
                { windowsHide: true }
            );
        }
        execFileSync(objcopy, ["-O", "ihex", "--only-section=.data", secondary, hex], { windowsHide: true });
        const payload = Buffer.from([0, 35, 36, 125, 42, 255, 0x80, 7]);
        fs.writeFileSync(bin, payload);
        const target = await memory.start();
        adapter.config = {
            executable: primary,
            nmPath: nm,
            rtos: "FreeRTOS",
            ...normalizeDebugImages(
                {
                    symbolFiles: [primary, { file: secondary, offset: "0x10000" }],
                    loadFiles: [primary, { file: hex, offset: "0x20000" }, { file: bin, address: "0x20030000" }]
                },
                root
            )
        };
        adapter.rtosAware = true;
        mi.start(gdb, root);
        await mi.command("-gdb-set auto-load off");
        await mi.command("-gdb-set may-call-functions off");
        await mi.command("-gdb-set architecture armv7e-m");
        await adapter.debugImages.symbols();
        await mi.command(`-target-select extended-remote ${target}`);
        await adapter.debugImages.download();
        assert.deepStrictEqual(
            memory.read(0x20030000, payload.length),
            payload,
            "BIN loads at the explicit address, including RSP escaped bytes"
        );
        adapter.ready = true;
        const globals = await adapter.symbolDirectory.variables("globals");
        const duplicates = globals.filter((entry) => entry.name.startsWith("duplicateGlobal"));
        assert.strictEqual(duplicates.length, 2, diagnostics.join(""));
        assert(duplicates.every((entry) => entry.expression && entry.image));
        const evaluate = async (expr) => (await mi.command(`-data-evaluate-expression ${quote(expr)}`)).value;
        const addresses = await Promise.all(
            duplicates.map((entry) => evaluate(`(unsigned long)&(${entry.expression})`))
        );
        assert.notStrictEqual(addresses[0], addresses[1]);
        const expectedPrimary = (await evaluate(duplicates[0].expression)) === "17" ? duplicates[0] : duplicates[1];
        const expectedSecond = duplicates.find((entry) => entry !== expectedPrimary);
        assert.strictEqual(await evaluate(expectedPrimary.expression), "17");
        // Secondary symbols relocate by 0x10000; HEX downloads separately by 0x20000.
        const secondAddress = Number(BigInt(await evaluate(`(unsigned long)&(${expectedSecond.expression})`)));
        assert.strictEqual(memory.read(secondAddress + 0x10000, 4).readInt32LE(), 29);
        assert.strictEqual(memory.read(secondAddress, 4).readInt32LE(), 0);
        await mi.command(`-interpreter-exec console ${quote(`set variable ${expectedPrimary.expression} = 41`)}`);
        assert.strictEqual(await evaluate(expectedPrimary.expression), "41");
        assert.strictEqual(
            memory.read(secondAddress + 0x10000, 4).readInt32LE(),
            29,
            "assignment preserves the other image"
        );
        const snapshot = await new FreeRtosSnapshot(adapter).snapshot();
        assert.deepStrictEqual(snapshot.diagnostics, [], diagnostics.join(""));
        assert(snapshot.kernel.supported && snapshot.kernel.symbolImage === primary);
        assert.strictEqual(snapshot.tasks[0].name, "Primary");
        assert.strictEqual(snapshot.tasks[0].priority, 3, "secondary TCB typedef cannot redirect layout resolution");
        assert.strictEqual(snapshot.tasks[0].stack.totalBytes, 32);
        for (const expression of [
            "pxCurrentTCB = 0",
            "xSchedulerRunning = 0",
            "uxCurrentNumberOfTasks = 0",
            "pxDelayedTaskList = 0",
            "pxOverflowDelayedTaskList = 0",
            "pxReadyTasksLists[0].xListEnd.pxNext = 0"
        ])
            await mi.command(`-interpreter-exec console ${quote(`set variable ${expression}`)}`);
        const beforeTasks = await new FreeRtosSnapshot(adapter).snapshot();
        assert.strictEqual(beforeTasks.kernel.state, "not-started");
        assert.strictEqual(beforeTasks.partial, false);
        assert.deepStrictEqual(beforeTasks.tasks, []);
        assert.deepStrictEqual(beforeTasks.diagnostics, []);
        // Restore this memory-only target before continuing the image tests.
        await adapter.debugImages.download();
        const afterStartup = await new FreeRtosSnapshot(adapter).snapshot();
        assert.strictEqual(afterStartup.kernel.state, "running");
        assert.strictEqual(afterStartup.tasks[0].name, "Primary");
        assert.strictEqual(afterStartup.partial, false);
        Object.assign(
            adapter.config,
            normalizeDebugImages(
                {
                    symbolFiles: [
                        primary,
                        {
                            file: secondary,
                            offset: "0x10000",
                            textaddress: "0x8010000",
                            sections: [{ name: ".data", address: "0x20020000" }]
                        }
                    ]
                },
                root
            )
        );
        await adapter.debugImages.symbols();
        const sectionGlobals = await adapter.symbolDirectory.variables("globals");
        const relocatedSecond = sectionGlobals.find(
            (entry) => entry.image === secondary.replace(/\\/g, "/") && entry.name.startsWith("duplicateGlobal")
        );
        assert(relocatedSecond.expression);
        assert.strictEqual(
            await evaluate(relocatedSecond.expression),
            "29",
            "explicit section address overrides the uniform symbol offset"
        );
        adapter.config.loadFiles = undefined;
        await adapter.debugImages.download();
        assert.strictEqual(
            memory
                .read(Number(BigInt(await evaluate(`(unsigned long)&(${expectedPrimary.expression})`))), 4)
                .readInt32LE(),
            17,
            "default executable download uses its file addresses"
        );
        adapter.config.loadFiles = normalizeDebugImages(
            { loadFiles: [{ file: primary, offset: "0x40000" }] },
            root
        ).loadFiles;
        await adapter.debugImages.download();
        assert.strictEqual(
            memory
                .read(Number(BigInt(await evaluate(`(unsigned long)&(${expectedPrimary.expression})`))) + 0x40000, 4)
                .readInt32LE(),
            17,
            "ELF load offset relocates transfer addresses"
        );
        const count = memory.writes.length;
        adapter.config.attach = true;
        await adapter.debugImages.download();
        assert.strictEqual(memory.writes.length, count, "attach performs no remote writes");
        console.log(
            "ARM GDB: ELF/HEX/BIN relocation, duplicate image expressions, assignment identity and primary RTOS typed layouts passed against memory-only RSP"
        );
    } catch (error) {
        fs.writeFileSync(
            path.join(outputRoot, "debug-images-native.log"),
            diagnostics.join("") + "\n" + memory.packets.join("\n") + "\n" + error.stack
        );
        throw error;
    } finally {
        const closed =
            mi.process && mi.process.exitCode === null
                ? new Promise((resolve) => mi.process.once("close", resolve))
                : Promise.resolve();
        await mi.stop();
        await closed;
        await memory.stop();
        assert(root.startsWith(outputRoot + path.sep));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
