"use strict";
const assert = require("assert");
const { parseElfSymbols, parseElfSections, nearestFunction } = require("../src/elfSymbols");
const { readElf32Header } = require("../src/elfFormat");
const { buildElf32, buildElf64, buildStringTable } = require("./helpers/elf-fixture");

assert.throws(
    () => readElf32Header(buildElf64()),
    /32 位 ELF/,
    "ELF64 fixtures must not relax the Cortex-M format guard"
);

// 程序化构造含命名节（shstrtab）、程序头与函数符号的最小 ELF32（小端，ARM）：
// .text @0x08000000（ALLOC|EXECINSTR）、.data @0x20000000（ALLOC|WRITE，LMA 0x08000100）、.bss（NOBITS）
function buildElf() {
    const sectionOrder = [".shstrtab", ".strtab", ".symtab", ".text", ".data", ".bss"];
    const names = buildStringTable(sectionOrder).data;
    const strings = buildStringTable(["myGlobal", "main", "uart_send"]).data;
    const stringOffset = 52 + names.length;
    const symbolOffset = (stringOffset + strings.length + 3) & ~3;
    const programOffset = symbolOffset + 5 * 16;
    return buildElf32({
        sections: [
            { name: ".text", flags: 0x6, addr: 0x08000000, offset: 0, size: 0x100, data: Buffer.alloc(0) },
            { name: ".data", flags: 0x3, addr: 0x20000000, offset: 0x100, size: 0x10, data: Buffer.alloc(0) },
            { name: ".bss", type: 8, flags: 0x3, addr: 0x20000010, size: 0x20 }
        ],
        symbols: [
            { name: "myGlobal", value: 0x20000000, size: 4, info: 0x11, section: 5 },
            { name: "main", value: 0x08000001, size: 0x40, info: 0x12, section: 4 },
            { name: "uart_send", value: 0x08000041, size: 0x20, info: 0x12, section: 4 },
            { name: "main", value: 0x08000061, size: 0x10, info: 0x02, section: 4 }
        ],
        programHeaders: [
            { offset: 0, vaddr: 0x08000000, paddr: 0x08000000, filesz: 0x100, memsz: 0x100, flags: 5 },
            { offset: 0x100, vaddr: 0x20000000, paddr: 0x08000100, filesz: 0x10, memsz: 0x30, flags: 6 }
        ],
        layout: {
            sectionOrder,
            sectionOffsets: { ".shstrtab": 52, ".strtab": stringOffset, ".symtab": symbolOffset },
            programHeaderOffset: programOffset,
            sectionHeaderOffset: programOffset + 64
        }
    });
}

(() => {
    const elf = buildElf();

    // —— parseElfSections：节名 / 加载地址 / 标志 / 程序头 ——
    const { sections, programHeaders } = parseElfSections(elf);
    const byName = new Map(sections.map((s) => [s.name, s]));
    const text = byName.get(".text");
    assert.ok(text, "should resolve section names via shstrtab");
    assert.strictEqual(text.addr, 0x08000000);
    assert.strictEqual(text.flags, 0x6);
    assert.strictEqual(text.type, 1);
    assert.strictEqual(text.size, 0x100);
    const data = byName.get(".data");
    assert.strictEqual(data.addr, 0x20000000);
    assert.strictEqual(data.flags, 0x3);
    const bss = byName.get(".bss");
    assert.strictEqual(bss.type, 8, ".bss is SHT_NOBITS");
    assert.strictEqual(bss.size, 0x20);

    assert.strictEqual(programHeaders.length, 2);
    assert.strictEqual(programHeaders[1].vaddr, 0x20000000);
    assert.strictEqual(programHeaders[1].paddr, 0x08000100, ".data LMA comes from p_paddr");
    assert.strictEqual(programHeaders[1].filesz, 0x10);
    assert.strictEqual(programHeaders[1].memsz, 0x30);

    // —— Flash/RAM 汇总口径（与 extension._analyzeElf 相同规则）——
    const SHF_WRITE = 1,
        SHF_ALLOC = 2,
        SHT_NOBITS = 8;
    const alloc = sections.filter((s) => s.flags & SHF_ALLOC && s.size);
    const flashTotal = alloc.filter((s) => s.type !== SHT_NOBITS).reduce((sum, s) => sum + s.size, 0);
    const ramTotal = alloc.filter((s) => s.flags & SHF_WRITE).reduce((sum, s) => sum + s.size, 0);
    assert.strictEqual(flashTotal, 0x110, "flash = .text + .data load copy");
    assert.strictEqual(ramTotal, 0x30, "ram = .data + .bss");

    // —— parseElfSymbols：函数符号收集（Thumb bit 清除、按地址升序）——
    const { symbols, functions } = parseElfSymbols(elf);
    assert.deepStrictEqual(
        symbols.map((s) => s.name),
        ["myGlobal"]
    );
    assert.deepStrictEqual(
        functions.map((f) => f.name),
        ["main", "uart_send", "main"],
        "same-name functions at distinct addresses must be preserved"
    );
    assert.strictEqual(functions[0].address, 0x08000000, "Thumb bit must be cleared");
    assert.strictEqual(functions[1].address, 0x08000040);
    assert.strictEqual(functions[2].address, 0x08000060);

    // —— nearestFunction：函数内命中 / 越界 / 低于首函数（displayName 缺省回落原始名）——
    assert.deepStrictEqual(nearestFunction(functions, 0x08000012), {
        name: "main",
        displayName: "main",
        offset: 0x12
    });
    assert.deepStrictEqual(
        nearestFunction(functions, 0x08000051),
        { name: "uart_send", displayName: "uart_send", offset: 0x10 },
        "Thumb bit in query address is cleared"
    );
    assert.deepStrictEqual(
        nearestFunction(functions, 0x08000065),
        { name: "main", displayName: "main", offset: 0x4 },
        "later same-name static function must remain symbolizable"
    );
    assert.strictEqual(nearestFunction(functions, 0x08000100), null, "past the end of the last function");
    assert.strictEqual(nearestFunction(functions, 0x07000000), null, "below the first function");
    assert.strictEqual(nearestFunction([], 0x08000000), null);

    console.log("ELF analyze tests passed");
})();
