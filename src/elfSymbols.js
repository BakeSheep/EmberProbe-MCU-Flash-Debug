"use strict";
// 纯 JS 解析 ELF32（小端，Cortex-M）符号表，提取全局/静态变量的地址与大小。
// 说明：本模块为受 MCUViewer（GPLv3）的 Variable Viewer 概念启发的独立实现，未使用其任何代码。

const elfFormat = require("./elfFormat");
const { validateComposite } = require("./compositeValidation");

const { SUPPORTED_TYPES, typeByteLength, defaultType } = require("./webview/runtime");

function resolveVariableRequests(symbols, requests) {
    const list = Array.isArray(symbols) ? symbols : [];
    const exact = new Map(list.map((symbol) => [symbol.name, symbol]));
    const folded = new Map();
    for (const symbol of list) {
        const key = String(symbol.name || "").toLowerCase();
        if (!folded.has(key)) folded.set(key, []);
        folded.get(key).push(symbol);
    }
    const seen = new Set();
    return (Array.isArray(requests) ? requests : []).map((request) => {
        const requestedName = String(request?.name || "").trim();
        if (!requestedName)
            throw Object.assign(new Error("Variable name is required"), { code: "INVALID_VARIABLE_NAME" });
        let symbol = exact.get(requestedName);
        if (!symbol) {
            const matches = folded.get(requestedName.toLowerCase()) || [];
            if (matches.length === 1) symbol = matches[0];
            else if (matches.length > 1)
                throw Object.assign(new Error(`Variable name is ambiguous: ${requestedName}`), {
                    code: "AMBIGUOUS_VARIABLE"
                });
        }
        if (!symbol)
            throw Object.assign(new Error(`Variable not found in current ELF: ${requestedName}`), {
                code: "VARIABLE_NOT_FOUND"
            });
        if (seen.has(symbol.name))
            throw Object.assign(new Error(`Variable requested more than once: ${symbol.name}`), {
                code: "DUPLICATE_VARIABLE"
            });
        seen.add(symbol.name);
        const type = request.type || symbol.watchType || defaultType(symbol.size);
        if (!SUPPORTED_TYPES.includes(type))
            throw Object.assign(new Error(`Unsupported type for ${symbol.name}: ${type}`), {
                code: "UNSUPPORTED_VARIABLE_TYPE"
            });
        const width = typeByteLength(type);
        if (symbol.isComposite || width > Number(symbol.size))
            throw Object.assign(new Error(`Variable is not a supported scalar: ${symbol.name}`), {
                code: "UNSUPPORTED_VARIABLE"
            });
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

// 将数值按类型编码为小端字节数组（与 decodeValue 对称），越界/非法值抛错
function encodeValue(value, type) {
    if (!SUPPORTED_TYPES.includes(type))
        throw Object.assign(new Error(`Unsupported type: ${type}`), { code: "UNSUPPORTED_VARIABLE_TYPE" });
    const invalid = (message) => {
        throw Object.assign(new Error(message), { code: "INVALID_WRITE_VALUE" });
    };
    const width = typeByteLength(type);
    const view = new DataView(new ArrayBuffer(width));
    if (type === "u64" || type === "i64") {
        let integer;
        if (typeof value === "bigint") integer = value;
        else if (typeof value === "number") {
            if (!Number.isSafeInteger(value))
                invalid(`${type} requires a safe integer Number or an exact decimal string: ${value}`);
            integer = BigInt(value);
        } else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
            try {
                integer = BigInt(value.trim());
            } catch {
                invalid(`Invalid decimal integer for ${type}: ${value}`);
            }
        } else invalid(`${type} requires an integer value: ${value}`);
        const min = type === "u64" ? 0n : -(1n << 63n);
        const max = type === "u64" ? (1n << 64n) - 1n : (1n << 63n) - 1n;
        if (integer < min || integer > max) invalid(`Value out of range for ${type}: ${value}`);
        if (type === "u64") view.setBigUint64(0, integer, true);
        else view.setBigInt64(0, integer, true);
        return Array.from(new Uint8Array(view.buffer));
    }
    let number;
    if (type === "f64" && typeof value === "string") {
        const alias = value.trim().toLowerCase();
        if (alias === "nan") number = NaN;
        else if (alias === "inf" || alias === "+inf") number = Infinity;
        else if (alias === "-inf") number = -Infinity;
        else number = Number(value);
    } else number = Number(value);
    if (type !== "f64" && !Number.isFinite(number)) invalid(`Value is not a finite number: ${value}`);
    if (type === "f64" && typeof value === "string" && !value.trim()) invalid(`Value is not a number: ${value}`);
    if (
        type === "f64" &&
        Number.isNaN(number) &&
        !(typeof value === "number" && Number.isNaN(value)) &&
        !(typeof value === "string" && value.trim().toLowerCase() === "nan")
    )
        invalid(`Value is not a number: ${value}`);
    const ranges = {
        u8: [0, 0xff],
        i8: [-128, 127],
        u16: [0, 0xffff],
        i16: [-32768, 32767],
        u32: [0, 0xffffffff],
        i32: [-2147483648, 2147483647]
    };
    if (type !== "f32" && type !== "f64") {
        if (!Number.isInteger(number)) invalid(`${type} requires an integer value: ${value}`);
        const [min, max] = ranges[type];
        if (number < min || number > max) invalid(`Value out of range for ${type}: ${value}`);
    }
    switch (type) {
        case "u8":
            view.setUint8(0, number);
            break;
        case "i8":
            view.setInt8(0, number);
            break;
        case "u16":
            view.setUint16(0, number, true);
            break;
        case "i16":
            view.setInt16(0, number, true);
            break;
        case "u32":
            view.setUint32(0, number, true);
            break;
        case "i32":
            view.setInt32(0, number, true);
            break;
        case "f32":
            if (!Number.isFinite(Math.fround(number))) invalid(`Value out of range for f32: ${value}`);
            view.setFloat32(0, number, true);
            break;
        case "f64":
            view.setFloat64(0, number, true);
            break;
    }
    return Array.from(new Uint8Array(view.buffer));
}

// 从 src 的 offset 起按小端读取一个标量（decodeValue 与 decodeComposite 共用的唯一实现）
function decodeScalarAt(view, offset, type) {
    switch (type) {
        case "u8":
            return view.getUint8(offset);
        case "i8":
            return view.getInt8(offset);
        case "u16":
            return view.getUint16(offset, true);
        case "i16":
            return view.getInt16(offset, true);
        case "u32":
            return view.getUint32(offset, true);
        case "i32":
            return view.getInt32(offset, true);
        case "f32":
            return view.getFloat32(offset, true);
        case "u64":
            return Number(view.getBigUint64(offset, true));
        case "i64":
            return Number(view.getBigInt64(offset, true));
        case "f64":
            return view.getFloat64(offset, true);
        default:
            return null;
    }
}

// 将原始小端字节按类型解码为数值；bytes 可为 Buffer / Uint8Array / number[]
function decodeValue(bytes, type) {
    const need = typeByteLength(type);
    if (!bytes || bytes.length < need) return null;
    const view = new DataView(Uint8Array.from(bytes).buffer);
    return decodeScalarAt(view, 0, type);
}

// 64 位标量的精确/特殊文本表示；其他值返回 null。
function decodeValueText(bytes, type) {
    const need = typeByteLength(type);
    if (!bytes || bytes.length < need) return null;
    const view = new DataView(Uint8Array.from(bytes).buffer);
    if (type === "u64") return view.getBigUint64(0, true).toString(10);
    if (type === "i64") return view.getBigInt64(0, true).toString(10);
    if (type === "f64") {
        const value = view.getFloat64(0, true);
        if (Number.isNaN(value)) return "NaN";
        if (value === Infinity) return "Infinity";
        if (value === -Infinity) return "-Infinity";
    }
    return null;
}

// 解析 ELF32 符号表，返回 { symbols: [{name,address,size}], warnings: [] }
function parseElfSymbols(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const header = elfFormat.readElf32Header(buf);
    const warnings = [];
    if (header.machine !== 0x28) warnings.push(`e_machine=0x${header.machine.toString(16)} 非 ARM，解析结果可能不准确`);

    const sections = elfFormat.readSectionEntries(buf, header);
    const SHT_SYMTAB = 2;
    const SHT_DYNSYM = 11;
    let symtab = sections.find((s) => s.type === SHT_SYMTAB) || sections.find((s) => s.type === SHT_DYNSYM);
    if (!symtab) throw new Error("未找到符号表（.symtab）：请使用 Debug 构建且不要 strip");
    const strtab = sections[symtab.link];
    if (!strtab) throw new Error("符号字符串表（.strtab）缺失");
    const sectionInBounds = (section) => section.offset <= buf.length && section.size <= buf.length - section.offset;
    if (!sectionInBounds(symtab) || !sectionInBounds(strtab)) {
        throw new Error("ELF 符号表或字符串表越界");
    }

    const readCStr = (base, rel) => {
        const p = base + rel;
        const limit = base + strtab.size;
        if (rel < 0 || p < base || p >= limit) return "";
        let end = p;
        while (end < limit && buf[end] !== 0) end++;
        if (end === limit) return "";
        return buf.toString("utf8", p, end);
    };

    const STT_OBJECT = 1;
    const STT_FUNC = 2;
    const SHN_UNDEF = 0;
    const SHN_ABS = 0xfff1;
    const entsize = symtab.entsize || 16;
    if (entsize < 16) throw new Error("ELF 符号表条目大小无效");
    const count = Math.floor(symtab.size / entsize);
    const seen = new Map();
    const seenFuncs = new Map();
    for (let i = 0; i < count; i++) {
        const off = symtab.offset + i * entsize;
        if (off + 16 > buf.length) break;
        const stName = buf.readUInt32LE(off + 0);
        const stValue = buf.readUInt32LE(off + 4);
        const stSize = buf.readUInt32LE(off + 8);
        const stInfo = buf[off + 12];
        const stShndx = buf.readUInt16LE(off + 14);
        const stType = stInfo & 0xf;
        if (stShndx === SHN_UNDEF || stShndx === SHN_ABS) continue;
        if (stType === STT_FUNC) {
            // 函数符号单独收集（故障分析的 PC/LR 符号化与体积排名用），清除 Thumb bit
            const name = readCStr(strtab.offset, stName);
            const address = (stValue & ~1) >>> 0;
            // 不同编译单元可以有同名 static 函数；仅去除名称和地址都相同的重复条目。
            const key = `${name}\0${address}`;
            if (!name || seenFuncs.has(key)) continue;
            seenFuncs.set(key, { name, address, size: stSize >>> 0 });
            continue;
        }
        if (stType !== STT_OBJECT) continue; // 仅数据对象（变量）与函数
        const name = readCStr(strtab.offset, stName);
        if (!name || seen.has(name)) continue; // 同名取首个
        seen.set(name, { name, address: stValue >>> 0, size: stSize >>> 0 });
    }
    const symbols = Array.from(seen.values())
        .filter((s) => s.address !== 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    const functions = Array.from(seenFuncs.values())
        .filter((s) => s.address !== 0)
        .sort((a, b) => a.address - b.address);
    return { symbols, functions, warnings };
}

// 解析 ELF32 节头（含节名/加载地址/标志）与程序头，供可写段校验与 Flash/RAM 占用分析。
// 返回 { sections: [{name,type,addr,offset,size,flags}], programHeaders: [{vaddr,paddr,filesz,memsz,flags}] }
function parseElfSections(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const header = elfFormat.readElf32Header(buf);
    const entries = elfFormat.readSectionEntries(buf, header);
    const names = elfFormat.readSectionNames(buf, entries, header.shstrndx);
    const sections = entries.map((s, i) => ({
        name: names[i],
        type: s.type,
        addr: s.addr,
        offset: s.offset,
        size: s.size,
        flags: s.flags
    }));

    const { phoff, phentsize, phnum } = header;
    const programHeaders = [];
    if (phoff && phnum && phentsize >= 32 && phoff + phnum * phentsize <= buf.length) {
        for (let i = 0; i < phnum; i++) {
            const off = phoff + i * phentsize;
            programHeaders.push({
                type: buf.readUInt32LE(off + 0),
                offset: buf.readUInt32LE(off + 4),
                vaddr: buf.readUInt32LE(off + 8) >>> 0,
                paddr: buf.readUInt32LE(off + 12) >>> 0,
                filesz: buf.readUInt32LE(off + 16),
                memsz: buf.readUInt32LE(off + 20),
                flags: buf.readUInt32LE(off + 24)
            });
        }
    }
    return { sections, programHeaders };
}

// 在按地址升序的函数符号中定位地址所属函数，返回 { name, offset } 或 null
function nearestFunction(functions, address) {
    const addr = (Number(address) & ~1) >>> 0;
    if (!Array.isArray(functions) || !functions.length || !Number.isFinite(addr)) return null;
    let best = null;
    for (const fn of functions) {
        if (fn.address > addr) break; // 已按地址升序
        best = fn;
    }
    if (!best) return null;
    const offset = addr - best.address;
    // 有大小时要求落在函数范围内；无大小（汇编符号）时限制偏移不超 64KB 避免跨区域误报
    if (best.size > 0 ? offset >= best.size : offset > 0x10000) return null;
    return { name: best.name, offset };
}

// —— 复合类型路径解析与解码 ——

// 解析成员路径：sensor.x → { base:'sensor', segments:[{kind:'member',name:'x'}] }
// buf[0] → { base:'buf', segments:[{kind:'index',index:0}] }
// buf[1:5] → { base:'buf', segments:[{kind:'range',start:1,end:5}] }
// buf[*] → { base:'buf', segments:[{kind:'all'}] }
// buf[0].x → { base:'buf', segments:[{kind:'index',index:0},{kind:'member',name:'x'}] }
function parseMemberPath(pathStr) {
    const str = String(pathStr || "").trim();
    if (!str) return null;
    // 匹配 baseName 后跟 .member 或 [index/range/*]
    const m = str.match(/^([a-zA-Z_]\w*)/);
    if (!m) return null;
    const base = m[1];
    const rest = str.slice(base.length);
    const segments = [];
    let pos = 0;
    while (pos < rest.length) {
        if (rest[pos] === ".") {
            pos++;
            const nameMatch = rest.slice(pos).match(/^([a-zA-Z_]\w*)/);
            if (!nameMatch) return null;
            segments.push({ kind: "member", name: nameMatch[1] });
            pos += nameMatch[1].length;
        } else if (rest[pos] === "[") {
            pos++;
            const end = rest.indexOf("]", pos);
            if (end < 0) return null;
            const inner = rest.slice(pos, end).trim();
            if (inner === "*") {
                segments.push({ kind: "all" });
            } else if (inner.includes(":")) {
                const parts = inner.split(":");
                if (parts.length !== 2 || !/^\d*$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
                const start = parts[0] === "" ? 0 : Number(parts[0]);
                const endIdx = Number(parts[1]);
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endIdx) || endIdx <= start) return null;
                segments.push({ kind: "range", start, end: endIdx });
            } else {
                if (!/^\d+$/.test(inner)) return null;
                const idx = Number(inner);
                if (!Number.isSafeInteger(idx)) return null;
                segments.push({ kind: "index", index: idx });
            }
            pos = end + 1;
        } else {
            return null; // 非法字符
        }
    }
    return { base, segments };
}

// 将复合变量的叶子成员展开为扁平读取项列表
// symbol: { name, address, size }
// layout: CompositeLayout（来自 dwarf.parseCompositeLayout）
// pathSpec: parseMemberPath 的结果（可选，无则展开全部叶子）
// 返回 [{ name, path, address, size, type, typeName }]
function expandCompositeLeaves(symbol, layout, pathSpec) {
    if (!layout || !symbol) return [];
    validateComposite(layout, Number(symbol.size ?? layout.byteSize), Number(symbol.address));
    const baseAddr = Number(symbol.address) >>> 0;
    const leaves = [];

    function walk(currentLayout, currentOffset, currentPath, depth, pendingPathSpec = null) {
        if (depth > 10 || !currentLayout) return;
        if (currentLayout.kind === "struct" || currentLayout.kind === "union") {
            for (const m of currentLayout.members || []) {
                const memberPath = currentPath + "." + (m.name || "?");
                const memberOffset = currentOffset + (m.offset || 0);
                if (m.compositeLayout) {
                    walk(m.compositeLayout, memberOffset, memberPath, depth + 1, null);
                } else if (m.watchType) {
                    leaves.push({
                        name: symbol.name,
                        path: memberPath,
                        address: (baseAddr + memberOffset) >>> 0,
                        size: m.byteSize || typeByteLength(m.watchType),
                        type: m.watchType,
                        typeName: m.typeName || "",
                        ...(Number.isInteger(m.bitSize) ? { bitSize: m.bitSize, bitOffset: m.bitOffset } : {})
                    });
                }
            }
        } else if (currentLayout.kind === "array") {
            const elemType = currentLayout.elementType || {};
            const dims = currentLayout.dimensions || [];
            const total = currentLayout.totalElements || 0;
            const elemSize = elemType.byteSize || 0;
            // 确定要展开的元素范围
            let rangeStart = 0,
                rangeEnd = total;
            if (pendingPathSpec && pendingPathSpec.segments.length > 0) {
                const seg = pendingPathSpec.segments[0];
                const remainingSegments = pendingPathSpec.segments.slice(1);
                if (seg.kind === "index") {
                    if (seg.index < 0 || seg.index >= total) return;
                    rangeStart = seg.index;
                    rangeEnd = seg.index + 1;
                } else if (seg.kind === "range") {
                    if (seg.start < 0 || seg.end <= seg.start || seg.end > total) return;
                    rangeStart = seg.start;
                    rangeEnd = seg.end;
                } else if (seg.kind === "all") {
                    // 全部
                }
                // 嵌套路径段（如 buf[1:5].x）作用于复合元素时无法在此展开——walk 只消费
                // 首段，复合成员导航由下方的路径导航层负责。现状为不输出，交由导航层
                // 用单段路径（buf[1:5]）或成员段先行（buf[0].x）表达。
                if (remainingSegments.length > 0 && elemType.kind === "struct") return;
            }
            // 展开标量元素
            if (elemType.compositeLayout) {
                for (let i = rangeStart; i < rangeEnd; i++) {
                    walk(
                        elemType.compositeLayout,
                        currentOffset + i * elemSize,
                        currentPath + "[" + i + "]",
                        depth + 1,
                        null
                    );
                }
            } else if (elemType.watchType) {
                for (let i = rangeStart; i < rangeEnd; i++) {
                    leaves.push({
                        name: symbol.name,
                        path: currentPath + "[" + i + "]",
                        address: (baseAddr + currentOffset + i * elemSize) >>> 0,
                        size: elemSize,
                        type: elemType.watchType,
                        typeName: elemType.typeName || ""
                    });
                }
            }
        }
    }

    // 如果有路径规格，先导航到目标层级
    if (pathSpec && pathSpec.segments.length > 0) {
        let currentLayout = layout;
        let currentOffset = 0;
        let currentPath = symbol.name;
        let pendingPathSpec = null;
        for (let segmentIndex = 0; segmentIndex < pathSpec.segments.length; segmentIndex++) {
            const seg = pathSpec.segments[segmentIndex];
            if (seg.kind === "member" && (currentLayout.kind === "struct" || currentLayout.kind === "union")) {
                const member = (currentLayout.members || []).find((m) => m.name === seg.name);
                if (!member) return []; // 成员不存在
                currentOffset += member.offset || 0;
                currentPath += "." + member.name;
                if (member.compositeLayout) {
                    currentLayout = member.compositeLayout;
                } else {
                    // 到达标量叶子
                    if (segmentIndex !== pathSpec.segments.length - 1) return [];
                    return [
                        {
                            name: symbol.name,
                            path: currentPath,
                            address: (baseAddr + currentOffset) >>> 0,
                            size: member.byteSize || typeByteLength(member.watchType),
                            type: member.watchType,
                            typeName: member.typeName || "",
                            ...(Number.isInteger(member.bitSize)
                                ? { bitSize: member.bitSize, bitOffset: member.bitOffset }
                                : {})
                        }
                    ];
                }
            } else if (
                (seg.kind === "index" || seg.kind === "range" || seg.kind === "all") &&
                currentLayout.kind === "array"
            ) {
                const elemSize = currentLayout.elementType ? currentLayout.elementType.byteSize : 0;
                if (seg.kind === "index") {
                    const total = Number(currentLayout.totalElements) || 0;
                    if (seg.index < 0 || seg.index >= total) return [];
                    currentOffset += seg.index * elemSize;
                    currentPath += "[" + seg.index + "]";
                    if (currentLayout.elementType && currentLayout.elementType.compositeLayout) {
                        currentLayout = currentLayout.elementType.compositeLayout;
                        continue;
                    }
                    if (
                        currentLayout.elementType &&
                        currentLayout.elementType.kind !== "struct" &&
                        currentLayout.elementType.kind !== "union" &&
                        currentLayout.elementType.kind !== "array"
                    ) {
                        if (segmentIndex !== pathSpec.segments.length - 1) return [];
                        return [
                            {
                                name: symbol.name,
                                path: currentPath,
                                address: (baseAddr + currentOffset) >>> 0,
                                size: elemSize,
                                type: currentLayout.elementType.watchType,
                                typeName: currentLayout.elementType.typeName || ""
                            }
                        ];
                    }
                    return [];
                }
                // range / all：展开为多个叶子
                if (seg.kind === "range") {
                    const total = Number(currentLayout.totalElements) || 0;
                    if (seg.start < 0 || seg.end <= seg.start || seg.end > total) return [];
                }
                pendingPathSpec = { ...pathSpec, segments: pathSpec.segments.slice(segmentIndex) };
                break; // 跳出循环，交给 walk 处理
            } else {
                return []; // 路径不匹配
            }
        }
        // 如果导航后到达复合类型，展开其全部叶子
        walk(currentLayout, currentOffset, currentPath, 0, pendingPathSpec);
    } else {
        walk(layout, 0, symbol.name, 0, null);
    }
    return leaves;
}

// 从原始字节按布局解码为树形值结构
// bytes: Buffer / Uint8Array / number[]（变量的完整字节）
// layout: CompositeLayout
// 返回 { kind, typeName, members/elements, value? }
function decodeComposite(bytes, layout) {
    if (!bytes || !layout) return null;
    validateComposite(layout, Number(layout.byteSize ?? bytes.length));
    const src = Uint8Array.from(bytes);
    const view = new DataView(src.buffer, src.byteOffset);

    const decodeScalar = (offset, type) => {
        const width = typeByteLength(type);
        if (offset < 0 || offset + width > src.length) return null;
        return decodeScalarAt(view, offset, type);
    };

    const decodeBitfield = (offset, member) => {
        const width = member.byteSize || typeByteLength(member.watchType);
        if (offset < 0 || offset + width > src.length) return { value: null, valueText: null };
        return decodeBitfieldValue(
            src.subarray(offset, offset + width),
            member.watchType,
            member.bitOffset,
            member.bitSize
        );
    };

    // offset 为该节点相对变量基址的绝对字节偏移，供 UI/Agent 计算成员地址与定位路径。
    function decodeLayout(offset, lyt) {
        if (!lyt) return null;
        if (lyt.kind === "struct" || lyt.kind === "union") {
            const members = [];
            for (const m of lyt.members || []) {
                const mOff = offset + (m.offset || 0);
                if (m.compositeLayout) {
                    members.push({ name: m.name, ...decodeLayout(mOff, m.compositeLayout) });
                } else if (m.watchType) {
                    const width = typeByteLength(m.watchType);
                    const raw = mOff >= 0 && mOff + width <= src.length ? src.subarray(mOff, mOff + width) : null;
                    const decoded = Number.isInteger(m.bitSize)
                        ? decodeBitfield(mOff, m)
                        : { value: decodeScalar(mOff, m.watchType), valueText: decodeValueText(raw, m.watchType) };
                    members.push({
                        name: m.name,
                        offset: mOff,
                        ...decoded,
                        type: m.watchType,
                        typeName: m.typeName || "",
                        ...(Number.isInteger(m.bitSize) ? { bitSize: m.bitSize, bitOffset: m.bitOffset } : {})
                    });
                }
            }
            return { kind: lyt.kind, typeName: lyt.typeName, byteSize: lyt.byteSize, offset, members };
        }
        if (lyt.kind === "array") {
            const elemType = lyt.elementType || {};
            const elemSize = elemType.byteSize || 0;
            const total = lyt.totalElements || 0;
            const elements = [];
            for (let i = 0; i < total; i++) {
                const eOff = offset + i * elemSize;
                if (elemType.compositeLayout) {
                    const decoded = decodeLayout(eOff, elemType.compositeLayout);
                    if (decoded) elements.push({ index: i, ...decoded });
                } else if (elemType.watchType) {
                    const width = typeByteLength(elemType.watchType);
                    const raw = eOff >= 0 && eOff + width <= src.length ? src.subarray(eOff, eOff + width) : null;
                    elements.push({
                        index: i,
                        offset: eOff,
                        value: decodeScalar(eOff, elemType.watchType),
                        valueText: decodeValueText(raw, elemType.watchType),
                        type: elemType.watchType
                    });
                }
            }
            return {
                kind: "array",
                typeName: lyt.typeName,
                byteSize: lyt.byteSize,
                offset,
                elementType: elemType,
                dimensions: lyt.dimensions,
                elements
            };
        }
        return null;
    }

    return decodeLayout(0, layout);
}

function decodeBitfieldValue(bytes, type, bitOffset, bitSize) {
    const offset = Number(bitOffset);
    const size = Number(bitSize);
    if (!bytes || !Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size <= 0) {
        return { value: null, valueText: null };
    }
    const source = Uint8Array.from(bytes);
    if (offset + size > source.length * 8) return { value: null, valueText: null };
    let raw = 0n;
    for (let index = 0; index < source.length; index++) raw |= BigInt(source[index]) << BigInt(index * 8);
    const mask = (1n << BigInt(size)) - 1n;
    let value = (raw >> BigInt(offset)) & mask;
    if (/^i/.test(type) && value & (1n << BigInt(size - 1))) value -= 1n << BigInt(size);
    const text = value.toString(10);
    const number = Number(value);
    return { value: number, valueText: Number.isSafeInteger(number) ? null : text };
}

// 在已解码的树形值中按路径规格（parseMemberPath 的结果）导航到目标节点。
// 返回标量叶子节点（含 value/type/offset）或子树节点（struct/union/array）；找不到返回 null。
// range 段返回一个合成的数组子树（仅含选中范围内的元素）。
function navigateCompositeTree(tree, pathSpec) {
    if (!tree) return null;
    if (!pathSpec || !Array.isArray(pathSpec.segments) || !pathSpec.segments.length) return tree;
    let node = tree;
    for (const seg of pathSpec.segments) {
        if (!node) return null;
        if (seg.kind === "member") {
            if (!Array.isArray(node.members)) return null;
            node = node.members.find((m) => m.name === seg.name) || null;
        } else if (seg.kind === "index") {
            if (!Array.isArray(node.elements)) return null;
            node = node.elements.find((e) => e.index === seg.index) || null;
        } else if (seg.kind === "range") {
            if (!Array.isArray(node.elements)) return null;
            const els = node.elements.filter((e) => e.index >= seg.start && e.index < seg.end);
            node = {
                kind: "array",
                typeName: node.typeName,
                elementType: node.elementType,
                dimensions: node.dimensions,
                offset: els.length ? els[0].offset : node.offset,
                elements: els
            };
        } else if (seg.kind === "all") {
            // 停留在当前数组节点
        } else {
            return null;
        }
    }
    return node;
}

// 判断一个树节点是否为标量叶子（含 value/type，无 members/elements 子结构）。
function isScalarLeafNode(node) {
    return (
        !!node &&
        Object.prototype.hasOwnProperty.call(node, "value") &&
        !Object.prototype.hasOwnProperty.call(node, "members") &&
        !Object.prototype.hasOwnProperty.call(node, "elements")
    );
}

module.exports = {
    parseElfSymbols,
    parseElfSections,
    nearestFunction,
    decodeValue,
    decodeValueText,
    decodeBitfieldValue,
    encodeValue,
    decodeComposite,
    navigateCompositeTree,
    isScalarLeafNode,
    defaultType,
    typeByteLength,
    resolveVariableRequests,
    parseMemberPath,
    expandCompositeLeaves,
    SUPPORTED_TYPES
};
