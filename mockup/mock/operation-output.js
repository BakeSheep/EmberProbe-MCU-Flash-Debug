"use strict";

// Browser fixtures are generated from the actual download parser and status text.
const { parseLine } = require("../../src/openocdRunner");
const zh = require("../../src/i18n/zh");
const { CONNECTION: connection, memoryAnalysis } = require("./sidebar-data");
const flashSections = memoryAnalysis().result.regions.find((region) => region.name === "FLASH").sections;
const elf = connection.elf.replace(/\\/g, "/");
const elfName = elf.split("/").pop();
const probeBanner = "J-Link " + connection.probeVersion;
const flashLines = [
    [150, "Open On-Chip Debugger 0.12.0"],
    [350, "Info : " + probeBanner],
    [500, "Info : clock speed " + connection.clock],
    [650, "Info : Target voltage: 3.300000"],
    [850, "Info : device id = " + connection.deviceId],
    [1000, "Info : flash size = 1024 kbytes"],
    [1200, "Info : target halted due to debug-request, current mode: Thread"],
    [1500, "** Programming Started **"],
    [3200, "wrote 917504 bytes from file " + elf + " in 1.700s (527.059 KiB/s)"],
    [3600, "** Verify Started **"],
    [4100, "verified OK"],
    [4500, "** Resetting Target **"]
];
const steps = flashLines.map(([at, raw]) => {
    const event = parseLine(raw);
    if (!event) throw new Error("Unparsed mock download event: " + raw);
    return {
        at,
        raw,
        event,
        line: {
            cls: event.level === "success" ? "ok" : event.level === "error" ? "error" : "info",
            text: (event.level === "success" ? "✓ " : "→ ") + event.message
        }
    };
});

module.exports = {
    connection,
    terminalName: "EmberProbe OpenOCD",
    messages: Object.fromEntries(Object.entries(zh).filter(([key]) => key.startsWith("probe."))),
    download: {
        header: [
            { cls: "title", text: "EmberProbe 固件下载" },
            { text: "固件 " + elf },
            { text: "探针 " + connection.probe + " · 目标 " + connection.target },
            { text: "" }
        ],
        steps,
        summary: [
            { text: "" },
            { cls: "ok", text: "✓ 固件下载并校验成功" },
            { text: "  固件 " + elfName },
            { text: "  芯片 " + connection.deviceId },
            { text: "  Flash 容量 1024 kbytes" },
            { text: "  探针 " + probeBanner },
            { text: "  时钟 " + connection.clock },
            { text: "  写入 917504 bytes，耗时 1.7s（527.059 KiB/s）" },
            { text: "  目标 " + connection.target + " · 探针配置 " + connection.probe }
        ]
    },
    debug: {
        start: [{ text: "Reading symbols from " + elf + "..." }],
        steps: [
            { at: 550, lines: [{ text: "Remote debugging using 127.0.0.1:3333" }] },
            {
                at: 1100,
                lines: flashSections.map((section) => ({
                    text:
                        "Loading section " +
                        section.name +
                        ", size 0x" +
                        section.size.toString(16) +
                        " lma " +
                        section.loadAddress
                }))
            },
            {
                at: 1800,
                lines: [
                    { text: "Start address 0x08000198, load size 917504" },
                    { text: "Transfer rate: 527 KB/sec, 16384 bytes/write." }
                ]
            }
        ]
    }
};
