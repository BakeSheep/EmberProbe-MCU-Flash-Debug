"use strict";
const { MAX_COMPOSITE_DEPTH } = require("./dwarf/layoutLimits");
// 纯 JS 解析 ELF32（小端，Cortex-M）符号表，提取全局/静态变量的地址与大小。
// 说明：本模块为受 MCUViewer（GPLv3）的 Variable Viewer 概念启发的独立实现，未使用其任何代码。

const elfFormat = require("./elfFormat");
const { validateComposite } = require("./compositeValidation");

const {
    SUPPORTED_TYPES,
    typeByteLength,
    defaultType,
    layoutBranch,
    layoutMemberPath,
    layoutArrayIndices,
    formatPointer,
    summaryRoute,
    MAX_LAYOUT_PATH_DEPTH,
    MAX_LAYOUT_VISITS
} = require("./webview/runtime");

// Itanium ABI objects describe types, virtual dispatch, or initialization guards;
// they are not source variables and normally have no DW_TAG_variable layout.
function isCppRuntimeSymbol(name) {
    return /^_Z(?:T[IVSTC]|GV)/.test(name);
}

// Itanium mangling puts an uppercase letter or a length digit after "_Z": N (nested), L (internal
// linkage), Z (function-local static), S (substitution/std), T (typeinfo/vtable), G (guard), or a
// <length><identifier> source name such as _Z3amb. Requiring uppercase-or-digit keeps legitimate C
// identifiers such as _ZephyrState out — C reserves "_" plus an uppercase letter, but not "_" plus
// a lowercase one, so a bare /^_Z/ test misfires on them.
function isItaniumMangled(name) {
    return /^_Z[A-Z0-9]/.test(String(name));
}

function resolveVariableRequests(symbols, requests) {
    const list = Array.isArray(symbols) ? symbols : [];
    const exact = new Map(list.map((symbol) => [symbol.name, symbol]));
    // displayName 唯一别名：允许用 C++ 限定名解析；多个符号共享同一 displayName（重载/歧义）时不作别名。
    const byDisplay = new Map();
    for (const symbol of list) {
        const dn = symbol.displayName;
        if (!dn || dn === symbol.name) continue;
        byDisplay.set(dn, byDisplay.has(dn) ? null : symbol);
    }
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
        if (!symbol) symbol = byDisplay.get(requestedName) || undefined;
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
        const type = request.type || symbol.watchType || (symbol.isEnum ? "" : defaultType(symbol.size));
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

// Keep numeric/exact values intact for charts, CSV and write inputs.
const enumNames = new WeakMap();
function enumValueText(decoded, enumInfo) {
    if (!enumInfo || decoded.value == null) return null;
    const value = decoded.valueText ?? (Number.isSafeInteger(decoded.value) ? String(decoded.value) : null);
    if (value === null) return null;
    let names = enumNames.get(enumInfo);
    if (!names) {
        names = new Map();
        for (const entry of enumInfo.entries || []) {
            const prefix = entry.name.lastIndexOf("::");
            const label = prefix < 0 ? entry.name : "." + entry.name.slice(prefix + 2);
            const previous = names.get(entry.value);
            names.set(entry.value, previous ? previous + " / " + label : label);
        }
        enumNames.set(enumInfo, names);
    }
    const name = names.get(value);
    return name ? `${name}(${value})` : null;
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

    let scannedBytes = 0;
    const deadline = Date.now() + 10000;
    const names = new Map();
    const budgetError = () =>
        Object.assign(new Error("ELF symbol processing budget exceeded"), { code: "ELF_SYMBOL_BUDGET_EXCEEDED" });
    const readCStr = (base, rel) => {
        if (names.has(rel)) return names.get(rel);
        const p = base + rel;
        const limit = base + strtab.size;
        if (rel < 0 || p < base || p >= limit) return "";
        let end = p;
        while (end < limit && buf[end] !== 0) {
            if (++scannedBytes > 16 * 1024 * 1024 || end - p >= 16384) throw budgetError();
            end++;
        }
        if (end === limit) return "";
        const name = buf.toString("utf8", p, end);
        names.set(rel, name);
        return name;
    };

    const STT_NOTYPE = 0;
    const STT_OBJECT = 1;
    const STT_FUNC = 2;
    const STB_LOCAL = 0;
    const SHN_UNDEF = 0;
    const SHN_ABS = 0xfff1;
    const SHF_WRITE = 1;
    const SHF_ALLOC = 2;
    // GCC 在 -O0 且未启用 -fdata-sections 时，把 .bss 中的文件作用域 static（C 标量、C++ 匿名类型对象等）
    // 发成不带 .type 的 NOTYPE LOCAL 符号。仅接纳有尺寸、完整落在可写已分配节内的此类符号；
    // 映射符号 $d、节符号与链接脚本标记（尺寸为 0 或 GLOBAL）仍被排除。类型仍由 DWARF 决定。
    const isUntypedLocalData = (stInfo, stShndx, stValue, stSize) => {
        if (stInfo >> 4 !== STB_LOCAL || stSize === 0) return false;
        const section = sections[stShndx];
        if (!section || (section.flags & (SHF_WRITE | SHF_ALLOC)) !== (SHF_WRITE | SHF_ALLOC)) return false;
        return stValue >= section.addr && stValue + stSize <= section.addr + section.size;
    };
    const entsize = symtab.entsize || 16;
    if (entsize < 16) throw new Error("ELF 符号表条目大小无效");
    const count = Math.floor(symtab.size / entsize);
    if (count > 200000) throw budgetError();
    const seen = new Map();
    const seenFuncs = new Map();
    for (let i = 0; i < count; i++) {
        if (i % 1024 === 0 && Date.now() > deadline) throw budgetError();
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
        // 仅数据对象（变量）与函数
        if (stType !== STT_OBJECT && !(stType === STT_NOTYPE && isUntypedLocalData(stInfo, stShndx, stValue, stSize)))
            continue;
        const name = readCStr(strtab.offset, stName);
        if (!name || (stType === STT_NOTYPE && name.startsWith("$"))) continue;
        if (seen.has(name)) {
            const previous = seen.get(name);
            if (previous.address !== stValue || previous.size !== stSize) previous.addressAmbiguous = true;
            continue; // Preserve existing variable lookup, but CPU plans must reject ambiguous identities.
        }
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
    return { name: best.name, displayName: best.displayName || best.name, offset };
}

// —— 复合类型路径解析与解码 ——

// 解析成员路径：sensor.x → { base:'sensor', segments:[{kind:'member',name:'x'}] }
// buf[0] → { base:'buf', segments:[{kind:'index',index:0}] }
// buf[1:5] → { base:'buf', segments:[{kind:'range',start:1,end:5}] }
// buf[*] → { base:'buf', segments:[{kind:'all'}] }
// buf[0].x → { base:'buf', segments:[{kind:'index',index:0},{kind:'member',name:'x'}] }
function parseMemberPath(pathStr) {
    const str = String(pathStr || "").trim();
    if (!str || !/^[A-Za-z_]/.test(str)) return null;
    // 匹配 baseName 后跟 .member 或 [index/range/*]
    // base 允许 C++ 限定名（ns::Foo::bar）、模板名（Holder<int>::object）与 mangled 名（_Z...）。
    let depth = 0;
    let baseEnd = -1;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "<") {
            if (++depth > 32) return null;
        } else if (ch === ">") {
            if (depth <= 0) return null;
            depth--;
        } else if (depth === 0 && ch === "." && /^\.\d+(?=\.|\[|$)/.test(str.slice(i))) {
            // GCC C function statics retain their numeric ELF suffix in the base.
            i += str.slice(i).match(/^\.\d+/)[0].length - 1;
        } else if (depth === 0 && (ch === "." || ch === "[" || str.slice(i, i + 2) === "->")) {
            baseEnd = i;
            break;
        } else if (depth === 0 && !/[\w:]/.test(ch)) {
            return null;
        }
    }
    if (depth !== 0) return null;
    const base = (baseEnd === -1 ? str : str.slice(0, baseEnd)).trim();
    if (!base) return null;
    const rest = baseEnd === -1 ? "" : str.slice(baseEnd);
    const segments = [];
    let pos = 0;
    while (pos < rest.length) {
        if (rest.slice(pos, pos + 2) === "->") {
            segments.push({ kind: "dereference" });
            const nameMatch = rest.slice(pos + 2).match(/^[A-Za-z_]\w*/);
            if (!nameMatch) return null;
            segments.push({ kind: "member", name: nameMatch[0] });
            pos += 2 + nameMatch[0].length;
            continue;
        }
        if (rest[pos] === ".") {
            pos++;
            // 成员名允许 @baseN 基类段、? 匿名段、或标准标识符。
            const nameMatch = rest.slice(pos).match(/^(@base\d+|\?|[A-Za-z_]\w*)/);
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

// Resolve promoted anonymous members consistently for layouts and decoded trees.
// More than one match is ambiguous and must never select a writable address.
function findMemberRoute(node, name, nested, depth = 0) {
    if (depth > MAX_COMPOSITE_DEPTH) return null;
    const members = node.members || [];
    const direct = members.filter((member) => (name === "?" ? !member.name && nested(member) : member.name === name));
    if (direct.length) return direct.length === 1 ? [direct[0]] : [];
    let match = null;
    for (const member of members) {
        if (member.name || !nested(member) || member.unobservable) continue;
        const route = findMemberRoute(nested(member), name, nested, depth + 1);
        if (!route) continue;
        if (!route.length || match) return [];
        match = [member, ...route];
    }
    return match;
}

function leafFlags(member, isConst) {
    return {
        ...(member.enumInfo ? { enumInfo: member.enumInfo } : {}),
        ...(member.enumEncodingInferred ? { enumEncodingInferred: true } : {}),
        ...(member.isBoolean ? { isBoolean: true } : {}),
        ...(member.isConst || isConst ? { isConst: true } : {}),
        ...(member.isReference ? { isReference: true } : {}),
        ...(member.isMemberPointer ? { isMemberPointer: true } : {}),
        ...(member.isPointer ? { isPointer: true, pointerTarget: member.pointerTarget } : {})
    };
}

// Display state carried down a layout walk: an inherited hiding role, the remaining route
// to a library object's summary member, and the display alias once that member is reached.
function memberView(view, current, path, member, childPath) {
    // An outer library summary that is already routing through this object takes precedence.
    const summary = view.summary || (current.stdSummary ? { route: summaryRoute(current), owner: path } : null);
    if (!summary?.route || summary.route[0] !== member)
        return {
            role: view.role || member.memberRole || (summary?.route ? "internal" : undefined),
            alias: view.alias
        };
    const rest = summary.route.slice(1);
    const owner = view.alias ? view.alias.to + summary.owner.slice(view.alias.from.length) : summary.owner;
    return rest.length
        ? { role: view.role, summary: { route: rest, owner: summary.owner }, alias: view.alias }
        : { role: view.role, alias: { from: childPath, to: owner } };
}

function validateLayoutContext(symbol, layout) {
    validateComposite(layout, Number(symbol.size ?? layout.byteSize), Number(symbol.address || 0));
    if (symbol.layoutExpansionGeneration !== layout.expansionGeneration) return;
    const subroots = Object.values(symbol.layoutExpansions || {});
    if (subroots.length > 32)
        throw Object.assign(new Error("Too many detached layout expansions"), { code: "LAYOUT_EXPANSION_LIMIT" });
    for (const subroot of subroots) validateComposite(subroot, Number(subroot.byteSize));
}

function staticMemberRoute(node, name, symbol, path, depth = 0) {
    if (!node || depth > MAX_COMPOSITE_DEPTH) return null;
    const members = (node.members || []).map((member) => layoutBranch(symbol, member, layoutMemberPath(path, member)));
    const direct = members.filter((member) => (name === "?" ? !member.name : member.name === name));
    if (direct.length) return direct.length === 1 ? [direct[0]] : [];
    let match = null;
    for (const member of members) {
        if (member.name || member.unobservable || !member.compositeLayout) continue;
        const route = staticMemberRoute(
            member.compositeLayout,
            name,
            symbol,
            layoutMemberPath(path, member),
            depth + 1
        );
        if (!route) continue;
        if (!route.length || match) return [];
        match = [member, ...route];
    }
    return match;
}

// Resolve only verified by-value edges. The final unavailable node may be returned
// for handle binding, but navigation through it never guesses an address/type.
function resolveLayoutPath(symbol, layout, pathSpec, { finalExpansion = true } = {}) {
    if (!symbol || !layout || !pathSpec || pathSpec.segments.length > MAX_LAYOUT_PATH_DEPTH) return null;
    validateLayoutContext(symbol, layout);
    let node = layout,
        offset = 0,
        path = symbol.name,
        isConst = !!layout.isConst;
    let usedExpansion = false;
    for (let index = 0; index < pathSpec.segments.length; index++) {
        if (node.unobservable) return null;
        const current = node.compositeLayout || node;
        const segment = pathSpec.segments[index];
        const last = index === pathSpec.segments.length - 1;
        if (segment.kind === "member" && ["struct", "union", "class"].includes(current.kind)) {
            const route = staticMemberRoute(current, segment.name, symbol, path);
            if (!route?.length) return null;
            for (let step = 0; step < route.length; step++) {
                let entry = route[step];
                const nextPath = segment.name === "?" && !entry.name ? path + ".?" : layoutMemberPath(path, entry);
                if (last && step === route.length - 1 && !finalExpansion) {
                    const original = (current.members || []).find((member) => member.name === entry.name);
                    if (original) entry = original;
                }
                offset += entry.offset || 0;
                path = nextPath;
                isConst ||= !!entry.isConst || !!entry.compositeLayout?.isConst;
                usedExpansion ||= !!entry.expansionRoot;
                node = entry;
            }
        } else if (["index", "range", "all"].includes(segment.kind) && current.kind === "array") {
            const total = Number(current.totalElements) || 0;
            const element = current.elementType;
            if (!element) return null;
            if (segment.kind !== "index") {
                if (element.unobservable || (segment.kind === "range" && (segment.start < 0 || segment.end > total)))
                    return null;
                return {
                    node: current,
                    offset,
                    path,
                    isConst,
                    usedExpansion,
                    pendingPathSpec: { ...pathSpec, segments: pathSpec.segments.slice(index) }
                };
            }
            if (segment.index < 0 || segment.index >= total) return null;
            offset += segment.index * element.byteSize;
            path += "[" + segment.index + "]";
            node = last && !finalExpansion ? element : layoutBranch(symbol, element, path);
            isConst ||= !!current.isConst || !!node.isConst || !!node.compositeLayout?.isConst;
            usedExpansion ||= !!node.expansionRoot;
        } else return null;
        if (!last && !node.compositeLayout && !["struct", "union", "class", "array"].includes(node.kind)) return null;
    }
    return { node, offset, path, isConst, usedExpansion };
}

function expandedStaticLeaves(symbol, pathSpec) {
    if (!symbol?.layoutExpansions || !symbol.compositeLayout || !pathSpec?.segments.length) return [];
    const target = resolveLayoutPath(symbol, symbol.compositeLayout, pathSpec);
    return target?.usedExpansion ? expandCompositeLeaves(symbol, symbol.compositeLayout, pathSpec) : [];
}

// 将复合变量的叶子成员展开为扁平读取项列表
// symbol: { name, address, size }
// layout: CompositeLayout（来自 dwarf.parseCompositeLayout）
// pathSpec: parseMemberPath 的结果（可选，无则展开全部叶子）
// 返回 [{ name, path, address, size, type, typeName }]
function expandCompositeLeaves(symbol, layout, pathSpec) {
    if (!layout || !symbol) return [];
    validateLayoutContext(symbol, layout);
    const baseAddr = Number(symbol.address) >>> 0;
    const leaves = [];
    let visits = 0;
    const leaf = (member, offset, path, isConst, expanded, view) => {
        const displayPath = view.alias ? view.alias.to + path.slice(view.alias.from.length) : path;
        return {
            name: symbol.name,
            path,
            address: baseAddr + offset,
            size: member.byteSize || typeByteLength(member.watchType),
            type: member.watchType,
            typeName: member.typeName || "",
            ...leafFlags(member, isConst),
            ...(view.role ? { memberRole: view.role } : {}),
            ...(displayPath !== path ? { displayPath } : {}),
            ...(expanded ? { layoutExpanded: true } : {}),
            ...(Number.isInteger(member.bitSize) ? { bitSize: member.bitSize, bitOffset: member.bitOffset } : {})
        };
    };
    function walk(node, offset, path, depth, pending = null, isConst = false, expanded = false, view = {}) {
        if (++visits > MAX_LAYOUT_VISITS)
            throw Object.assign(new Error("Layout consumer visit budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
        if (!node || node.unobservable) return;
        if (depth > MAX_LAYOUT_PATH_DEPTH)
            throw Object.assign(new Error("Layout consumer depth budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
        isConst ||= !!node.isConst;
        expanded ||= !!node.expansionRoot;
        const current = node.compositeLayout || node;
        isConst ||= !!current.isConst;
        if (["struct", "union", "class"].includes(current.kind)) {
            for (const member of current.members || []) {
                const cp = layoutMemberPath(path, member);
                const resolved = layoutBranch(symbol, member, cp);
                const childPath = layoutMemberPath(path, resolved);
                walk(
                    resolved,
                    offset + (member.offset || 0),
                    childPath,
                    depth + 1,
                    null,
                    isConst,
                    expanded,
                    memberView(view, current, path, member, childPath)
                );
            }
        } else if (current.kind === "array") {
            const element = current.elementType || {};
            const total = current.totalElements || 0;
            let start = 0,
                end = total;
            if (pending?.segments.length) {
                const seg = pending.segments[0];
                if (seg.kind === "index") {
                    start = seg.index;
                    end = start + 1;
                } else if (seg.kind === "range") {
                    start = seg.start;
                    end = seg.end;
                }
                if (start < 0 || end > total || pending.segments.length > 1) return;
            }
            for (const index of layoutArrayIndices(symbol, current, path, start, end)) {
                const cp = path + "[" + index + "]";
                walk(
                    layoutBranch(symbol, element, cp),
                    offset + index * element.byteSize,
                    cp,
                    depth + 1,
                    null,
                    isConst,
                    expanded,
                    view
                );
            }
        } else if (node.watchType) leaves.push(leaf(node, offset, path, isConst, expanded, view));
    }
    if (pathSpec?.segments.length) {
        const target = resolveLayoutPath(symbol, layout, pathSpec);
        if (target)
            walk(
                target.node,
                target.offset,
                target.path,
                0,
                target.pendingPathSpec,
                target.isConst,
                target.usedExpansion
            );
    } else walk(layout, 0, symbol.name, 0);
    return leaves;
}

// 从原始字节按布局解码为树形值结构
// bytes: Buffer / Uint8Array / number[]（变量的完整字节）
// layout: CompositeLayout
// 返回 { kind, typeName, members/elements, value? }
function decodeComposite(bytes, layout, symbol = {}) {
    if (!bytes || !layout) return null;
    validateLayoutContext({ ...symbol, size: layout.byteSize ?? bytes.length }, layout);
    let visits = 0;
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
    function decodeLayout(offset, lyt, path, depth = 0, charge = true) {
        if ((charge && ++visits > MAX_LAYOUT_VISITS) || depth > MAX_LAYOUT_PATH_DEPTH)
            throw Object.assign(new Error("Layout decode budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
        if (!lyt) return null;
        if (lyt.kind === "struct" || lyt.kind === "union" || lyt.kind === "class") {
            const members = [];
            for (const original of lyt.members || []) {
                if (++visits > MAX_LAYOUT_VISITS)
                    throw Object.assign(new Error("Layout decode budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
                const cp = layoutMemberPath(path, original);
                const m = layoutBranch(symbol, original, cp);
                const mOff = offset + (m.offset || 0);
                if (m.unobservable) {
                    members.push({
                        name: m.name,
                        kind: m.kind || "unavailable",
                        typeName: m.typeName || "",
                        ...(m.memberRole ? { memberRole: m.memberRole } : {}),
                        unobservable: m.unobservable
                    });
                } else if (m.compositeLayout) {
                    members.push({
                        name: m.name,
                        ...decodeLayout(mOff, m.compositeLayout, layoutMemberPath(path, m), depth + 1, false),
                        ...(m.memberRole ? { memberRole: m.memberRole } : {}),
                        ...(m.expansionRoot ? { expansionRoot: true } : {})
                    });
                } else if (m.watchType) {
                    const width = typeByteLength(m.watchType);
                    const raw = mOff >= 0 && mOff + width <= src.length ? src.subarray(mOff, mOff + width) : null;
                    const decoded = Number.isInteger(m.bitSize)
                        ? decodeBitfield(mOff, m)
                        : { value: decodeScalar(mOff, m.watchType), valueText: decodeValueText(raw, m.watchType) };
                    if (m.isPointer && decoded.value !== null) decoded.valueText = formatPointer(decoded.value);
                    members.push({
                        name: m.name,
                        offset: mOff,
                        ...decoded,
                        ...(m.enumInfo ? { enumText: enumValueText(decoded, m.enumInfo) } : {}),
                        type: m.watchType,
                        typeName: m.typeName || "",
                        ...(m.isPointer ? { isPointer: true, pointerTarget: m.pointerTarget } : {}),
                        ...(m.memberRole ? { memberRole: m.memberRole } : {}),
                        ...(Number.isInteger(m.bitSize) ? { bitSize: m.bitSize, bitOffset: m.bitOffset } : {})
                    });
                }
            }
            return {
                kind: lyt.kind,
                typeName: lyt.typeName,
                byteSize: lyt.byteSize,
                offset,
                ...(lyt.stdSummary ? { stdSummary: lyt.stdSummary } : {}),
                members,
                ...(lyt.truncated ? { truncated: true } : {})
            };
        }
        if (lyt.kind === "array") {
            const elemType = lyt.elementType || {};
            const elemSize = elemType.byteSize || 0;
            const total = lyt.totalElements || 0;
            const elements = [];
            for (const i of layoutArrayIndices(symbol, lyt, path, 0, total)) {
                if (++visits > MAX_LAYOUT_VISITS)
                    throw Object.assign(new Error("Layout decode budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
                const cp = path + "[" + i + "]";
                const element = layoutBranch(symbol, elemType, cp);
                const eOff = offset + i * elemSize;
                if (element.unobservable) continue;
                if (element.compositeLayout) {
                    const decoded = decodeLayout(eOff, element.compositeLayout, cp, depth + 1, false);
                    if (decoded) elements.push({ index: i, ...decoded });
                } else if (elemType.watchType) {
                    const width = typeByteLength(elemType.watchType);
                    const raw = eOff >= 0 && eOff + width <= src.length ? src.subarray(eOff, eOff + width) : null;
                    const decoded = {
                        value: decodeScalar(eOff, elemType.watchType),
                        valueText: decodeValueText(raw, elemType.watchType)
                    };
                    if (elemType.isPointer && decoded.value !== null) decoded.valueText = formatPointer(decoded.value);
                    elements.push({
                        index: i,
                        offset: eOff,
                        ...decoded,
                        ...(elemType.enumInfo ? { enumText: enumValueText(decoded, elemType.enumInfo) } : {}),
                        type: elemType.watchType,
                        typeName: elemType.typeName || "",
                        ...(elemType.isPointer ? { isPointer: true, pointerTarget: elemType.pointerTarget } : {})
                    });
                }
            }
            return {
                kind: "array",
                typeName: lyt.typeName,
                byteSize: lyt.byteSize,
                offset,
                elementType: elemType,
                ...(lyt.truncated ? { truncated: true } : {}),
                ...(elemType.unobservable && !elements.length ? { unobservable: elemType.unobservable } : {}),
                dimensions: lyt.dimensions,
                elements
            };
        }
        return null;
    }

    return decodeLayout(0, layout, symbol.name || "");
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
            const route = findMemberRoute(node, seg.name, (member) => (Array.isArray(member.members) ? member : null));
            node = route?.length ? route[route.length - 1] : null;
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
        !node.unobservable &&
        Object.prototype.hasOwnProperty.call(node, "value") &&
        !Object.prototype.hasOwnProperty.call(node, "members") &&
        !Object.prototype.hasOwnProperty.call(node, "elements")
    );
}

module.exports = {
    parseElfSymbols,
    isCppRuntimeSymbol,
    isItaniumMangled,
    parseElfSections,
    nearestFunction,
    decodeValue,
    decodeValueText,
    enumValueText,
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
    resolveLayoutPath,
    expandedStaticLeaves,
    SUPPORTED_TYPES
};
