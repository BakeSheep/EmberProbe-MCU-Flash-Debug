"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { normalizeDebugImages, DebugImages, HOOKS, address } = require("../src/services/debugImages");
const { validateDebugConfiguration } = require("../src/services/debugConfiguration");
const { EmberDebugSession } = require("../src/debug/session");
const { quote } = require("../src/debug/mi");

class ImageMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.closed = false;
    }
    start() {
        this.started = true;
    }
    async stop() {
        this.stopped = true;
    }
    async command(command, timeout) {
        this.commands.push({ command, timeout });
        if (this.fail && command.includes(this.fail)) throw new Error("fixture failure");
        if (command === "-thread-info") return { threads: [{ id: "1" }], "current-thread-id": "1" };
        return {};
    }
}

function session(config) {
    const mi = new ImageMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    const events = [];
    adapter.sendEvent = (event) => events.push(event);
    adapter.config = config;
    return { mi, adapter, events };
}
const consoleCommand = (command) => `-interpreter-exec console ${quote(command)}`;

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-images-")));
    try {
        const primary = path.join(root, "primary.elf");
        const secondary = path.join(root, "second image.elf");
        const hex = path.join(root, "flash.hex");
        const bin = path.join(root, "data.bin");
        for (const file of [primary, secondary, hex, bin]) fs.writeFileSync(file, "fixture");
        const elf = Buffer.alloc(88);
        elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
        elf.writeUInt16LE(0x28, 18);
        elf.writeUInt32LE(52, 28);
        elf.writeUInt16LE(32, 42);
        elf.writeUInt16LE(1, 44);
        elf.writeUInt32LE(1, 52);
        elf.writeUInt32LE(84, 56);
        elf.writeUInt32LE(0x20000000, 64);
        elf.writeUInt32LE(4, 68);
        fs.writeFileSync(primary, elf);
        fs.writeFileSync(secondary, elf);
        fs.writeFileSync(hex, ":00000001FF\n");
        const badElf = path.join(root, "bad.elf");
        for (const [offset, value, width] of [
            [18, 62, 2],
            [28, 500, 4],
            [44, 5000, 2],
            [56, 100, 4]
        ]) {
            const bytes = Buffer.from(elf);
            if (width === 2) bytes.writeUInt16LE(value, offset);
            else bytes.writeUInt32LE(value, offset);
            fs.writeFileSync(badElf, bytes);
            assert.throws(() => normalizeDebugImages({ loadFiles: [badElf] }, root));
        }
        fs.writeFileSync(badElf, elf);
        for (const offset of ["-0x20000001", "0xe0000000"])
            assert.throws(
                () => normalizeDebugImages({ loadFiles: [{ file: badElf, offset }] }, root),
                /ARM32 address range/
            );
        const hexRecord = (type, data = [], address = 0) => {
            const bytes = Buffer.from([data.length, address >> 8, address & 255, type, ...data]);
            const checksum = -bytes.reduce((sum, byte) => sum + byte, 0) & 255;
            return ":" + bytes.toString("hex") + checksum.toString(16).padStart(2, "0");
        };
        const validHex = [
            hexRecord(2, [0, 1]),
            hexRecord(0, [1, 2]),
            hexRecord(4, [0x20, 0]),
            hexRecord(0, [3, 4]),
            hexRecord(3, [0, 0, 0, 0]),
            hexRecord(5, [8, 0, 0, 0]),
            hexRecord(1)
        ].join("\n");
        fs.writeFileSync(hex, validHex);
        assert(normalizeDebugImages({ loadFiles: [hex] }, root).loadFiles.length);
        assert.throws(
            () => normalizeDebugImages({ loadFiles: [{ file: hex, offset: "-0x100" }] }, root),
            /ARM32 address range/
        );
        fs.writeFileSync(hex, [hexRecord(4, [255, 255]), hexRecord(0, [1, 2], 65535), hexRecord(1)].join("\n"));
        assert.throws(() => normalizeDebugImages({ loadFiles: [hex] }, root), /ARM32 address range/);
        fs.writeFileSync(hex, hexRecord(6));
        assert.throws(() => normalizeDebugImages({ loadFiles: [hex] }, root), /record type/);
        fs.writeFileSync(hex, ":00000001FF\n");
        const defaults = { executable: primary, gdbPath: "gdb", gdbTarget: "127.0.0.1:3333", runToEntryPoint: "" };
        assert.deepStrictEqual(normalizeDebugImages({}, root), {});
        const normalized = normalizeDebugImages(
            {
                symbolFiles: [
                    "primary.elf",
                    { file: "second image.elf", offset: -4096, sections: [{ name: ".data", address: "0x20000000" }] }
                ],
                loadFiles: [{ file: "data.bin", address: 0x20000000 }],
                preLaunchCommands: ["monitor reset halt"]
            },
            root
        );
        assert.strictEqual(normalized.symbolFiles[0].file, primary);
        assert.strictEqual(normalized.symbolFiles[1].offset, "-0x1000");
        assert.strictEqual(normalized.loadFiles[0].format, "bin");
        assert.strictEqual(normalized.loadFiles[0].address, "0x20000000");
        assert.deepStrictEqual(normalizeDebugImages({ symbolFiles: [], loadFiles: [] }, root), {
            symbolFiles: [],
            loadFiles: []
        });
        for (const invalid of [null, {}, "files", Array(33).fill(primary), [{ file: root }], [{ file: "missing" }]])
            assert.throws(() => normalizeDebugImages({ symbolFiles: invalid }, root));
        for (const invalid of [
            { symbolFiles: [primary, primary] },
            { symbolFiles: [{ file: primary, unknown: true }] },
            { symbolFiles: [{ file: primary, sections: [{ name: ".x;quit", address: 0 }] }] },
            {
                symbolFiles: [
                    {
                        file: primary,
                        sections: [
                            { name: ".data", address: 0 },
                            { name: ".data", address: 1 }
                        ]
                    }
                ]
            },
            { symbolFiles: [{ file: primary, textaddress: "&function" }] },
            { symbolFiles: [{ file: primary, sections: "sections" }] },
            { loadFiles: [bin] },
            { loadFiles: [{ file: bin, address: 0xffffffff }] },
            { loadFiles: [{ file: bin, address: 0, offset: 0 }] },
            { loadFiles: [{ file: primary, address: 0 }] },
            { loadFiles: [{ file: bin, format: "binary", address: 0 }] },
            { loadFiles: [{ file: primary, offset: "0x10; quit" }] }
        ])
            assert.throws(() => normalizeDebugImages(invalid, root));
        assert.throws(() => normalizeDebugImages({ loadFiles: [{ file: bin, format: "elf" }] }, root), /Truncated|ELF/);
        for (const bad of [
            ":00000001FE",
            ":0100000011EF",
            ":00000001FF\n:00000001FF",
            ":02000004FFFFFC\n:02FFFF001122CD\n:00000001FF",
            ":01",
            "fixture"
        ]) {
            fs.writeFileSync(hex, bad);
            assert.throws(() => normalizeDebugImages({ loadFiles: [hex] }, root));
        }
        fs.writeFileSync(hex, ":00000001FF\n");
        for (const hook of HOOKS) {
            for (const invalid of ["monitor halt", [""], ["echo a\necho b"], [1], Array(65).fill("echo x")])
                assert.throws(() => normalizeDebugImages({ [hook]: invalid }, root), new RegExp(hook));
        }
        for (const invalid of [null, {}, "NaN", -1, 0x100000000, 1.5, "0x", "0x10\n"])
            assert.throws(() => address(invalid));
        assert.strictEqual(address("-0xffffffff", true), "-0xffffffff");
        assert.throws(() => address(-0x100000000, true));
        const folder = { uri: { fsPath: root } };
        assert.strictEqual(
            validateDebugConfiguration({ request: "launch", symbolFiles: ["primary.elf"] }, folder).symbolFiles[0].file,
            primary
        );

        for (const attach of [false, true]) {
            const { adapter, mi, events } = session({});
            await adapter.handle(attach ? "attach" : "launch", {
                ...defaults,
                preLaunchCommands: ["echo pre-launch"],
                postLaunchCommands: ["echo post-launch"],
                preAttachCommands: ["echo pre-attach"],
                postAttachCommands: ["echo post-attach"],
                preResetCommands: ["echo pre-reset"],
                postResetCommands: ["echo post-reset"]
            });
            const commands = mi.commands.map((item) => item.command);
            const prefix = attach ? "attach" : "launch";
            assert(
                commands.indexOf(consoleCommand(`echo pre-${prefix}`)) >
                    commands.indexOf("-target-select extended-remote 127.0.0.1:3333")
            );
            assert(
                commands.indexOf(consoleCommand(`echo pre-${prefix}`)) <
                    commands.indexOf(consoleCommand(attach ? "monitor halt" : "monitor reset halt"))
            );
            assert(
                commands.indexOf(consoleCommand(`echo post-${prefix}`)) >
                    commands.indexOf(consoleCommand(attach ? "monitor halt" : "monitor reset halt"))
            );
            assert.strictEqual(commands.includes("-target-download"), !attach);
            assert(!commands.includes(consoleCommand(`echo pre-${attach ? "launch" : "attach"}`)));
            assert(
                events.some((event) => event.body?.output?.includes(attach ? "preAttachCommands" : "preLaunchCommands"))
            );
            await adapter.handle("restart", {});
            const reset = mi.commands.slice(commands.length).map((item) => item.command);
            assert(
                reset.indexOf(consoleCommand("echo pre-reset")) < reset.indexOf(consoleCommand("monitor reset halt"))
            );
            assert(
                reset.indexOf(consoleCommand("echo post-reset")) > reset.indexOf(consoleCommand("monitor reset halt"))
            );
            assert(!reset.some((command) => command.includes("download") || command.includes('"load ')));
        }
        const multi = session({
            ...defaults,
            ...normalizeDebugImages(
                {
                    symbolFiles: [
                        { file: primary, offset: "0x1000" },
                        {
                            file: secondary,
                            textaddress: "0x8008000",
                            sections: [{ name: ".data", address: "0x20000000" }]
                        }
                    ],
                    loadFiles: [{ file: primary, offset: "0x1000" }, hex, { file: bin, address: "0x20008000" }]
                },
                root
            )
        });
        const images = new DebugImages(multi.adapter);
        await images.symbols();
        assert.strictEqual(multi.adapter.config.primarySymbolFile, primary);
        assert(
            multi.mi.commands.some((item) => item.command.includes("symbol-file") && item.command.includes("-o 0x1000"))
        );
        assert(
            multi.mi.commands.some(
                (item) => item.command.includes("add-symbol-file") && item.command.includes(" -s .data 0x20000000")
            )
        );
        await images.download();
        assert.strictEqual(multi.mi.commands.filter((item) => item.command.includes('console "load')).length, 3);
        assert(
            multi.mi.commands
                .filter((item) => item.command.includes('console "load'))
                .every((item) => item.timeout === 60000)
        );
        assert.strictEqual(multi.mi.commands.filter((item) => item.command === "-file-symbol-file").length, 2);
        assert(multi.mi.commands.some((item) => item.command === "-gdb-set gnutarget auto"));
        multi.mi.fail = "load";
        await assert.rejects(images.download(), /fixture failure/);
        multi.adapter.config.loadFiles = [
            normalizeDebugImages({ loadFiles: [{ file: bin, address: 0 }] }, root).loadFiles[0]
        ];
        await assert.rejects(images.download(), /fixture failure/);
        assert.strictEqual(multi.mi.commands.at(-1).command, "-gdb-set gnutarget auto");
        multi.adapter.config.attach = true;
        const before = multi.mi.commands.length;
        await images.download();
        assert.strictEqual(multi.mi.commands.length, before);
        const empty = session({ ...defaults, symbolFiles: [], loadFiles: [] });
        await empty.adapter.debugImages.symbols();
        await empty.adapter.debugImages.download();
        assert.strictEqual(empty.mi.commands.length, 2);
        assert.strictEqual(empty.adapter.config.primarySymbolFile, null);
        const rtosImages = session({
            ...defaults,
            rtos: "FreeRTOS",
            symbolFiles: [{ file: primary }, { file: secondary }],
            primarySymbolFile: primary
        });
        rtosImages.adapter.rtosAware = true;
        let rtosEntries = [
            {
                image: primary.replace(/\\/g, "/"),
                name: "pxCurrentTCB",
                expression: "pxCurrentTCB",
                symbolAddress: "0x20000000"
            }
        ];
        rtosImages.adapter.symbolDirectory.load = async (options) => {
            assert(options.symbolSetup);
            return rtosEntries;
        };
        rtosImages.mi.command = async () => ({ value: "536870912" });
        await rtosImages.adapter.debugImages.verifyRtosPrimary();
        rtosImages.mi.command = async () => ({ value: "536875008" });
        await assert.rejects(rtosImages.adapter.debugImages.verifyRtosPrimary(), /does not select the primary/);
        rtosEntries = [];
        await assert.rejects(rtosImages.adapter.debugImages.verifyRtosPrimary(), /missing an unambiguous/);
        rtosImages.adapter.config.rtos = "auto";
        await rtosImages.adapter.debugImages.verifyRtosPrimary();

        const failed = session({});
        failed.mi.fail = "bad-hook";
        const response = new Promise((resolve) => {
            failed.adapter.sendErrorResponse = () => resolve();
        });
        failed.adapter.dispatchRequest({
            seq: 1,
            type: "request",
            command: "launch",
            arguments: { ...defaults, preLaunchCommands: ["bad-hook"] }
        });
        await response;
        await failed.adapter.queue;
        assert(
            failed.mi.stopped && failed.adapter.ended,
            "hook failures close GDB through the DAP launch failure path"
        );
        await assert.rejects(failed.adapter.debugImages.hooks("preLaunchCommands"), /preLaunchCommands failed/);
        const invalid = session({});
        await assert.rejects(invalid.adapter.handle("launch", { ...defaults, loadFiles: [bin] }), /explicit address/);
        assert(!invalid.mi.started, "validation precedes starting GDB");
        console.log("Debug image validation, symbol/download lifecycle, attach protection and phased hooks passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
