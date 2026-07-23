"use strict";
// 纯 JS 解析 ELF32（小端，Cortex-M）符号表，提取全局/静态变量的地址与大小。
// 说明：本模块为受 MCUViewer（GPLv3）的 Variable Viewer 概念启发的独立实现，未使用其任何代码。

const SUPPORTED_TYPES = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32'];

// 各标量类型的字节宽度（不支持 64 位，与 MCUViewer 1.1.0 一致）
function typeByteLength(type) {
    switch (type) {
        case 'u8': case 'i8': return 1;
        case 'u16': case 'i16': return 2;
        case 'u32': case 'i32': case 'f32': return 4;
        default: return 4;
    }
}

// 无 DWARF 时依符号大小猜测默认类型，用户可在 UI 覆盖
function defaultType(size) {
    if (size === 1) return 'u8';
    if (size === 2) return 'u16';
    return 'u32';
}

function resolveVariableRequests(symbols, requests) {
    const list = Array.isArray(symbols) ? symbols : [];
    const exact = new Map(list.map(symbol => [symbol.name, symbol]));
    const folded = new Map();
    for (const symbol of list) {
        const key = String(symbol.name || '').toLowerCase();
        if (!folded.has(key)) folded.set(key, []);
        folded.get(key).push(symbol);
    }
    const seen = new Set();
    return (Array.isArray(requests) ? requests : []).map(request => {
        const requestedName = String(request?.name || '').trim();
        if (!requestedName) throw Object.assign(new Error('Variable name is required'), { code: 'INVALID_VARIABLE_NAME' });
        let symbol = exact.get(requestedName);
        if (!symbol) {
            const matches = folded.get(requestedName.toLowerCase()) || [];
            if (matches.length === 1) symbol = matches[0];
            else if (matches.length > 1) throw Object.assign(new Error(`Variable name is ambiguous: ${requestedName}`), { code: 'AMBIGUOUS_VARIABLE' });
        }
        if (!symbol) throw Object.assign(new Error(`Variable not found in current ELF: ${requestedName}`), { code: 'VARIABLE_NOT_FOUND' });
        if (seen.has(symbol.name)) throw Object.assign(new Error(`Variable requested more than once: ${symbol.name}`), { code: 'DUPLICATE_VARIABLE' });
        seen.add(symbol.name);
        const type = request.type || symbol.watchType || defaultType(symbol.size);
        if (!SUPPORTED_TYPES.includes(type)) throw Object.assign(new Error(`Unsupported type for ${symbol.name}: ${type}`), { code: 'UNSUPPORTED_VARIABLE_TYPE' });
        const width = typeByteLength(type);
        if (symbol.isComposite || width > Number(symbol.size)) throw Object.assign(new Error(`Variable is not a supported scalar: ${symbol.name}`), { code: 'UNSUPPORTED_VARIABLE' });
        return {
            requestedName,
            name: symbol.name,
            address: Number(symbol.address) >>> 0,
            size: width,
            symbolSize: Number(symbol.size) || width,
            type
        };
    });
}

// 将原始小端字节按类型解码为数值；bytes 可为 Buffer / Uint8Array / number[]
function decodeValue(bytes, type) {
    const need = typeByteLength(type);
    if (!bytes || bytes.length < need) return null;
    const view = new DataView(Uint8Array.from(bytes).buffer);
    switch (type) {
        case 'u8': return view.getUint8(0);
        case 'i8': return view.getInt8(0);
        case 'u16': return view.getUint16(0, true);
        case 'i16': return view.getInt16(0, true);
        case 'u32': return view.getUint32(0, true);
        case 'i32': return view.getInt32(0, true);
        case 'f32': return view.getFloat32(0, true);
        default: return null;
    }
}

// 解析 ELF32 符号表，返回 { symbols: [{name,address,size}], warnings: [] }
function parseElfSymbols(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (buf.length < 52) throw new Error('文件过小，不是有效的 ELF');
    if (!(buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)) {
        throw new Error('不是有效的 ELF 文件（魔数不匹配）');
    }
    const eiClass = buf[4]; // 1 = 32 位
    const eiData = buf[5];  // 1 = 小端
    if (eiClass !== 1) throw new Error('仅支持 32 位 ELF（Cortex-M）');
    if (eiData !== 1) throw new Error('仅支持小端 ELF（Cortex-M）');

    const warnings = [];
    const eMachine = buf.readUInt16LE(18);
    if (eMachine !== 0x28) warnings.push(`e_machine=0x${eMachine.toString(16)} 非 ARM，解析结果可能不准确`);

    const eShoff = buf.readUInt32LE(32);
    const eShentsize = buf.readUInt16LE(46) || 40;
    const eShnum = buf.readUInt16LE(48);
    if (!eShoff || !eShnum) throw new Error('缺少节头表，可能已被 strip（请用 Debug 构建）');
    if (eShentsize < 40 || eShoff + eShnum * eShentsize > buf.length) {
        throw new Error('ELF 节头表越界或条目大小无效');
    }

    // 读取全部节头（仅取解析符号所需字段）
    const sections = [];
    for (let i = 0; i < eShnum; i++) {
        const off = eShoff + i * eShentsize;
        if (off + 40 > buf.length) break;
        sections.push({
            type: buf.readUInt32LE(off + 4),
            offset: buf.readUInt32LE(off + 16),
            size: buf.readUInt32LE(off + 20),
            link: buf.readUInt32LE(off + 24),
            entsize: buf.readUInt32LE(off + 36)
        });
    }

    const SHT_SYMTAB = 2;
    const SHT_DYNSYM = 11;
    let symtab = sections.find(s => s.type === SHT_SYMTAB) || sections.find(s => s.type === SHT_DYNSYM);
    if (!symtab) throw new Error('未找到符号表（.symtab）：请使用 Debug 构建且不要 strip');
    const strtab = sections[symtab.link];
    if (!strtab) throw new Error('符号字符串表（.strtab）缺失');
    const sectionInBounds = section =>
        section.offset <= buf.length && section.size <= buf.length - section.offset;
    if (!sectionInBounds(symtab) || !sectionInBounds(strtab)) {
        throw new Error('ELF 符号表或字符串表越界');
    }

    const readCStr = (base, rel) => {
        const p = base + rel;
        const limit = base + strtab.size;
        if (rel < 0 || p < base || p >= limit) return '';
        let end = p;
        while (end < limit && buf[end] !== 0) end++;
        if (end === limit) return '';
        return buf.toString('utf8', p, end);
    };

    const STT_OBJECT = 1;
    const SHN_UNDEF = 0;
    const SHN_ABS = 0xfff1;
    const entsize = symtab.entsize || 16;
    if (entsize < 16) throw new Error('ELF 符号表条目大小无效');
    const count = Math.floor(symtab.size / entsize);
    const seen = new Map();
    for (let i = 0; i < count; i++) {
        const off = symtab.offset + i * entsize;
        if (off + 16 > buf.length) break;
        const stName = buf.readUInt32LE(off + 0);
        const stValue = buf.readUInt32LE(off + 4);
        const stSize = buf.readUInt32LE(off + 8);
        const stInfo = buf[off + 12];
        const stShndx = buf.readUInt16LE(off + 14);
        if ((stInfo & 0xf) !== STT_OBJECT) continue; // 仅数据对象（变量）
        if (stShndx === SHN_UNDEF || stShndx === SHN_ABS) continue;
        const name = readCStr(strtab.offset, stName);
        if (!name || seen.has(name)) continue; // 同名取首个
        seen.set(name, { name, address: stValue >>> 0, size: stSize >>> 0 });
    }
    const symbols = Array.from(seen.values())
        .filter(s => s.address !== 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    return { symbols, warnings };
}

module.exports = { parseElfSymbols, decodeValue, defaultType, typeByteLength, resolveVariableRequests, SUPPORTED_TYPES };
