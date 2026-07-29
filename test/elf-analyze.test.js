"use strict";
const assert = require("assert");
const { parseElfSymbols, parseElfSections, nearestFunction } = require("../src/elfSymbols");

// 程序化构造含命名节（shstrtab）、程序头与函数符号的最小 ELF32（小端，ARM）：
// .text @0x08000000（ALLOC|EXECINSTR）、.data @0x20000000（ALLOC|WRITE，LMA 0x08000100）、.bss（NOBITS）
function buildElf() {
    const shstrtab = Buffer.from("\0.shstrtab\0.strtab\0.symtab\0.text\0.data\0.bss\0", "latin1");
    const strtab = Buffer.from("\0myGlobal\0main\0uart_send\0", "latin1"); // 名称偏移：1 / 10 / 15
    const shstrtabOff = 52;
    const strtabOff = shstrtabOff + shstrtab.length;            // 96
    const symtabOff = (strtabOff + strtab.length + 3) & ~3;     // 124
    const symCount = 5;                                         // null / myGlobal / main / uart_send / another static main
    const phoff = symtabOff + symCount * 16;                    // 188
    const phnum = 2;
    const shoff = phoff + phnum * 32;                           // 252
    const shnum = 7;
    const buf = Buffer.alloc(shoff + shnum * 40);

    // ELF 头
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
    buf[4] = 1; buf[5] = 1; buf[6] = 1;      // 32 位 / 小端 / 版本
    buf.writeUInt16LE(2, 16);                // e_type ET_EXEC
    buf.writeUInt16LE(0x28, 18);             // e_machine ARM
    buf.writeUInt32LE(1, 20);                // e_version
    buf.writeUInt32LE(phoff, 28);            // e_phoff
    buf.writeUInt32LE(shoff, 32);            // e_shoff
    buf.writeUInt16LE(52, 40);               // e_ehsize
    buf.writeUInt16LE(32, 42);               // e_phentsize
    buf.writeUInt16LE(phnum, 44);            // e_phnum
    buf.writeUInt16LE(40, 46);               // e_shentsize
    buf.writeUInt16LE(shnum, 48);            // e_shnum
    buf.writeUInt16LE(1, 50);                // e_shstrndx → .shstrtab

    shstrtab.copy(buf, shstrtabOff);
    strtab.copy(buf, strtabOff);

    // 符号表：myGlobal（OBJECT，.data）、main / uart_send（FUNC，.text，带 Thumb bit）
    const sym = (i, name, value, size, info, shndx) => {
        const off = symtabOff + i * 16;
        buf.writeUInt32LE(name, off + 0);
        buf.writeUInt32LE(value, off + 4);
        buf.writeUInt32LE(size, off + 8);
        buf[off + 12] = info;
        buf.writeUInt16LE(shndx, off + 14);
    };
    sym(1, 1, 0x20000000, 4, 0x11, 5);       // myGlobal：GLOBAL|OBJECT
    sym(2, 10, 0x08000001, 0x40, 0x12, 4);   // main：GLOBAL|FUNC（Thumb bit）
    sym(3, 15, 0x08000041, 0x20, 0x12, 4);   // uart_send：GLOBAL|FUNC（Thumb bit）
    sym(4, 10, 0x08000061, 0x10, 0x02, 4);   // 另一编译单元中的同名 static main

    // 程序头：PT_LOAD .text（LMA=VMA）与 PT_LOAD .data（VMA=RAM，LMA=Flash 装载副本）
    const ph = (i, type, offset, vaddr, paddr, filesz, memsz, flags) => {
        const off = phoff + i * 32;
        buf.writeUInt32LE(type, off + 0);
        buf.writeUInt32LE(offset, off + 4);
        buf.writeUInt32LE(vaddr, off + 8);
        buf.writeUInt32LE(paddr, off + 12);
        buf.writeUInt32LE(filesz, off + 16);
        buf.writeUInt32LE(memsz, off + 20);
        buf.writeUInt32LE(flags, off + 24);
    };
    ph(0, 1, 0, 0x08000000, 0x08000000, 0x100, 0x100, 5);
    ph(1, 1, 0x100, 0x20000000, 0x08000100, 0x10, 0x30, 6);

    // 节头表：name 为 shstrtab 内偏移
    const sh = (i, name, type, flags, addr, offset, size, link, entsize) => {
        const off = shoff + i * 40;
        buf.writeUInt32LE(name, off + 0);
        buf.writeUInt32LE(type, off + 4);
        buf.writeUInt32LE(flags, off + 8);
        buf.writeUInt32LE(addr, off + 12);
        buf.writeUInt32LE(offset, off + 16);
        buf.writeUInt32LE(size, off + 20);
        buf.writeUInt32LE(link, off + 24);
        buf.writeUInt32LE(entsize, off + 36);
    };
    // 索引 0：空节
    sh(1, 1, 3, 0, 0, shstrtabOff, shstrtab.length, 0, 0);            // .shstrtab STRTAB
    sh(2, 11, 3, 0, 0, strtabOff, strtab.length, 0, 0);               // .strtab STRTAB
    sh(3, 19, 2, 0, 0, symtabOff, symCount * 16, 2, 16);              // .symtab SYMTAB → link .strtab
    sh(4, 27, 1, 0x6, 0x08000000, 0, 0x100, 0, 0);                    // .text PROGBITS ALLOC|EXECINSTR
    sh(5, 33, 1, 0x3, 0x20000000, 0x100, 0x10, 0, 0);                 // .data PROGBITS ALLOC|WRITE
    sh(6, 39, 8, 0x3, 0x20000010, 0, 0x20, 0, 0);                     // .bss NOBITS ALLOC|WRITE
    return buf;
}

(() => {
    const elf = buildElf();

    // —— parseElfSections：节名 / 加载地址 / 标志 / 程序头 ——
    const { sections, programHeaders } = parseElfSections(elf);
    const byName = new Map(sections.map(s => [s.name, s]));
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
    const SHF_WRITE = 1, SHF_ALLOC = 2, SHT_NOBITS = 8;
    const alloc = sections.filter(s => (s.flags & SHF_ALLOC) && s.size);
    const flashTotal = alloc.filter(s => s.type !== SHT_NOBITS).reduce((sum, s) => sum + s.size, 0);
    const ramTotal = alloc.filter(s => s.flags & SHF_WRITE).reduce((sum, s) => sum + s.size, 0);
    assert.strictEqual(flashTotal, 0x110, "flash = .text + .data load copy");
    assert.strictEqual(ramTotal, 0x30, "ram = .data + .bss");

    // —— parseElfSymbols：函数符号收集（Thumb bit 清除、按地址升序）——
    const { symbols, functions } = parseElfSymbols(elf);
    assert.deepStrictEqual(symbols.map(s => s.name), ["myGlobal"]);
    assert.deepStrictEqual(functions.map(f => f.name), ["main", "uart_send", "main"], "same-name functions at distinct addresses must be preserved");
    assert.strictEqual(functions[0].address, 0x08000000, "Thumb bit must be cleared");
    assert.strictEqual(functions[1].address, 0x08000040);
    assert.strictEqual(functions[2].address, 0x08000060);

    // —— nearestFunction：函数内命中 / 越界 / 低于首函数 ——
    assert.deepStrictEqual(nearestFunction(functions, 0x08000012), { name: "main", offset: 0x12 });
    assert.deepStrictEqual(nearestFunction(functions, 0x08000051), { name: "uart_send", offset: 0x10 }, "Thumb bit in query address is cleared");
    assert.deepStrictEqual(nearestFunction(functions, 0x08000065), { name: "main", offset: 0x4 }, "later same-name static function must remain symbolizable");
    assert.strictEqual(nearestFunction(functions, 0x08000100), null, "past the end of the last function");
    assert.strictEqual(nearestFunction(functions, 0x07000000), null, "below the first function");
    assert.strictEqual(nearestFunction([], 0x08000000), null);

    console.log("ELF analyze tests passed");
})();
