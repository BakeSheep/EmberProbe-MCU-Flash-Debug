"use strict";
const { MAX_COMPOSITE_DEPTH } = require("./dwarf/layoutLimits");
const { isStdType } = require("./dwarf/memberRoles");
// Pure JS parser for the ELF32 (little-endian, Cortex-M) symbol table, extracting addresses and sizes of global and
// static variables. It is an independent implementation inspired by the Variable Viewer concept of MCUViewer (GPLv3)
// and uses none of its code.

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
    variableScope,
    scopedVariableName,
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

function normalizeSourcePath(value) {
    return String(value || "").replace(/\\/g, "/");
}
// Path suffixes only match at separator boundaries: main.c matches src/main.c but not mymain.c.
function sourceMatches(source, file) {
    return !!source && !!file && (source === file || source.endsWith("/" + file));
}
function uniqueSourceSuffix(paths, index) {
    const segments = paths[index].split("/").filter(Boolean);
    for (let count = 1; count <= segments.length; count++) {
        const suffix = segments.slice(-count).join("/");
        if (paths.filter((source) => sourceMatches(source, suffix)).length === 1) return suffix;
    }
    return "";
}
// Same-named internal-linkage variables (C statics of different compilation units, C++ _ZL/anonymous-namespace objects,
// numbered function-local statics) share an ELF name at different addresses. Each gets the unique identity <shortest
// unique source path suffix>::<ELF name>, or 0x<address>::<ELF name> when indistinguishable. The source file comes from
// the DWARF CU whose variable has exactly that address, otherwise from STT_FILE (basename only). Repeatable: pass
// variables once DWARF is ready to refine identities.
const MAX_QUALIFIED_GROUP = 64;
function qualifySameNameSymbols(symbols, variables = null) {
    const sources = new Map();
    for (const variable of variables || []) {
        if (variable.address === undefined || !variable.sourceFile) continue;
        const previous = sources.get(variable.address);
        sources.set(
            variable.address,
            previous === undefined || previous === variable.sourceFile ? variable.sourceFile : null
        );
    }
    const groups = new Map();
    for (const symbol of symbols) {
        const elfName = symbol.elfName || symbol.name;
        if (!groups.has(elfName)) groups.set(elfName, []);
        groups.get(elfName).push(symbol);
    }
    const result = [];
    const identities = new Map();
    for (const [elfName, group] of groups) {
        if (group.length === 1) {
            const [symbol] = group;
            if (symbol.elfName) {
                symbol.name = elfName;
                delete symbol.elfName;
                delete symbol.scope;
                delete symbol.sameNameCount;
            }
            result.push(symbol);
            continue;
        }
        const paths = group.map((symbol) => normalizeSourcePath(sources.get(symbol.address) || symbol.objectFile));
        group.forEach((symbol, index) => {
            const dwarfSource = sources.get(symbol.address);
            if (dwarfSource) symbol.sourceFile = dwarfSource;
            const address = "0x" + (symbol.address >>> 0).toString(16);
            const suffix = group.length <= MAX_QUALIFIED_GROUP ? uniqueSourceSuffix(paths, index) : "";
            const scopedName = suffix && scopedVariableName(suffix, elfName);
            const name = scopedName || scopedVariableName(address, elfName);
            const previous = identities.get(name);
            if (previous) {
                // Same-named symbols at one address with different sizes have no unique identity: keep the first,
                // flagged ambiguous, so every read or write by name is rejected.
                previous.addressAmbiguous = true;
                return;
            }
            delete symbol.addressAmbiguous;
            Object.assign(symbol, {
                name,
                elfName,
                scope: scopedName ? suffix : address,
                sameNameCount: group.length
            });
            identities.set(name, symbol);
            result.push(symbol);
        });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
// Same-named symbols are first published with STT_FILE identities and refined in place by source path once DWARF is
// ready. Returns the refined list and, for each same-named symbol, [old identity, new identity | null (merged because
// of address ambiguity)].
function refineSameNameSymbols(symbols, variables) {
    const previous = new Map(symbols.filter((symbol) => symbol.elfName).map((symbol) => [symbol, symbol.name]));
    if (!previous.size) return { symbols, identities: [] };
    const refined = qualifySameNameSymbols(symbols, variables);
    const kept = new Set(refined);
    const identities = Array.from(previous, ([symbol, name]) => [
        name,
        kept.has(symbol)
            ? {
                  name: symbol.name,
                  elfName: symbol.elfName,
                  scope: symbol.scope,
                  sameNameCount: symbol.sameNameCount,
                  sourceFile: symbol.sourceFile || "",
                  addressAmbiguous: !!symbol.addressAmbiguous
              }
            : null
    ]);
    return { symbols: refined, identities };
}
function symbolCandidates(symbols) {
    return symbols.slice(0, 32).map((symbol) => ({
        name: symbol.name,
        ...(symbol.displayName && symbol.displayName !== symbol.name ? { displayName: symbol.displayName } : {}),
        sourceFile: symbol.sourceFile || symbol.objectFile || "",
        address: "0x" + (Number(symbol.address) >>> 0).toString(16).toUpperCase(),
        size: Number(symbol.size) || 0
    }));
}
function scopeMatches(symbols, file) {
    if (/^0x[0-9a-f]+$/i.test(file)) {
        const address = parseInt(file, 16);
        return symbols.filter((symbol) => Number(symbol.address) >>> 0 === address);
    }
    const wanted = normalizeSourcePath(file).replace(/^(?:\.\/)+/, "");
    const filter = (fold) => {
        const target = fold ? wanted.toLowerCase() : wanted;
        return symbols.filter((symbol) =>
            [symbol.sourceFile, symbol.objectFile].some((source) => {
                const path = normalizeSourcePath(source);
                return sourceMatches(fold ? path.toLowerCase() : path, target);
            })
        );
    };
    const matches = filter(false);
    return matches.length ? matches : filter(true);
}
// Variable name resolution shared by agent reads/writes, watch lists and the UI:
// 1. exact identity name;
// 2. compilation-unit qualified file.c::name, 'dir/file.c'::name or 0xADDR::name (file names match by path suffix, only
// a unique CU is accepted);
// 3. a unique displayName alias (C++ qualified name);
// 4. a unique case-insensitive match.
// A bare name defined in several compilation units is always rejected with VARIABLE_AMBIGUOUS and its candidates, never
// the first match. foldCase: false disables step 4 (write targets must be named exactly); candidates differing only in
// case appear in the error details.
function createSymbolResolver(symbols, { foldCase = true } = {}) {
    const list = Array.isArray(symbols) ? symbols : [];
    let exact = null,
        byKey = null,
        folded = null;
    const index = () => {
        if (exact) return;
        exact = new Map();
        byKey = new Map();
        folded = new Map();
        const add = (map, key, symbol) => {
            if (!key) return;
            const entries = map.get(key);
            if (!entries) map.set(key, [symbol]);
            else if (!entries.includes(symbol)) entries.push(symbol);
        };
        for (const symbol of list) {
            exact.set(symbol.name, symbol);
            add(byKey, symbol.elfName || symbol.name, symbol);
            if (symbol.displayName && symbol.displayName !== symbol.name) {
                add(byKey, symbol.displayName, symbol);
                add(byKey, variableScope(symbol.displayName)?.name, symbol);
            }
            add(folded, String(symbol.name || "").toLowerCase(), symbol);
        }
    };
    const ambiguous = (requestedName, matches) =>
        Object.assign(
            new Error(
                `Variable name is ambiguous: ${requestedName} matches ${matches.length} variables in different ` +
                    `compilation units; qualify it as file::name, e.g. ${matches[0].displayName || matches[0].name}`
            ),
            { code: "VARIABLE_AMBIGUOUS", details: { requestedName, candidates: symbolCandidates(matches) } }
        );
    const accept = (symbol, requestedName) => {
        if (symbol.addressAmbiguous)
            throw ambiguous(requestedName, byKey.get(symbol.elfName || symbol.name) || [symbol]);
        return symbol;
    };
    return (name, requestedName = name) => {
        index();
        const key = String(name ?? "").trim();
        const direct = exact.get(key);
        if (direct) return accept(direct, requestedName);
        const scope = variableScope(key);
        if (scope) {
            const named = byKey.get(scope.name) || [];
            const matches = scopeMatches(named, scope.file);
            if (matches.length === 1) return accept(matches[0], requestedName);
            if (matches.length > 1) throw ambiguous(requestedName, matches);
            throw Object.assign(new Error(`Variable not found in compilation unit ${scope.file}: ${requestedName}`), {
                code: "VARIABLE_NOT_FOUND",
                details: { requestedName, candidates: symbolCandidates(named) }
            });
        }
        const matches = byKey.get(key) || [];
        if (matches.length > 1) throw ambiguous(requestedName, matches);
        if (matches.length === 1) return accept(matches[0], requestedName);
        // Case-insensitive fallback as for scalars: accept a unique match and leave several to the ambiguity error
        const foldedMatches = folded.get(key.toLowerCase()) || [];
        if (!foldCase && foldedMatches.length)
            throw Object.assign(
                new Error(`Variable not found in current ELF (names are case-sensitive): ${requestedName}`),
                {
                    code: "VARIABLE_NOT_FOUND",
                    details: { requestedName, candidates: symbolCandidates(foldedMatches) }
                }
            );
        if (foldedMatches.length === 1) return accept(foldedMatches[0], requestedName);
        if (foldedMatches.length > 1)
            throw Object.assign(new Error(`Variable name is ambiguous: ${requestedName}`), {
                code: "AMBIGUOUS_VARIABLE"
            });
        throw Object.assign(new Error(`Variable not found in current ELF: ${requestedName}`), {
            code: "VARIABLE_NOT_FOUND"
        });
    };
}

function resolveVariableRequests(symbols, requests) {
    const resolve = createSymbolResolver(symbols);
    const seen = new Set();
    return (Array.isArray(requests) ? requests : []).map((request) => {
        const requestedName = String(request?.name || "").trim();
        if (!requestedName)
            throw Object.assign(new Error("Variable name is required"), { code: "INVALID_VARIABLE_NAME" });
        const symbol = resolve(requestedName);
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

// Encodes a number as little-endian bytes for its type (the inverse of decodeValue); out-of-range or invalid values
// throw
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
    // Number() turns null, "", " ", false, [] and [n] into numbers; a missing value must never write 0.
    if (!(typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && value.trim())))
        invalid(`${type} requires a number or a non-empty numeric string: ${value}`);
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

// Reads one little-endian scalar from src at offset (the single implementation behind decodeValue and decodeComposite)
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

// Decodes raw little-endian bytes by type; bytes may be a Buffer, Uint8Array or number[]
function decodeValue(bytes, type) {
    const need = typeByteLength(type);
    if (!bytes || bytes.length < need) return null;
    const view = new DataView(Uint8Array.from(bytes).buffer);
    return decodeScalarAt(view, 0, type);
}

// Exact or special text for 64-bit scalars; null for other values.
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

// Parses the ELF32 symbol table and returns { symbols: [{name,address,size}], warnings: [] }
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
    const STT_FILE = 4;
    const STB_LOCAL = 0;
    const SHN_UNDEF = 0;
    const SHN_ABS = 0xfff1;
    const SHF_WRITE = 1;
    const SHF_ALLOC = 2;
    // At -O0 without -fdata-sections GCC emits file-scope statics in .bss (C scalars, C++ objects of anonymous types,
    // ...) as NOTYPE LOCAL symbols without .type. Only sized ones entirely inside a writable allocated section are
    // accepted; $d mapping symbols, section symbols and linker script markers (size 0 or GLOBAL) stay excluded. DWARF
    // still decides the type.
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
    // STT_FILE marks the object file (usually just the source basename) of the local symbols that follow,
    // distinguishing same-named statics when DWARF is unavailable.
    let objectFile = "";
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
        if (stType === STT_FILE) {
            objectFile = stInfo >> 4 === STB_LOCAL ? readCStr(strtab.offset, stName) : "";
            continue;
        }
        if (stShndx === SHN_UNDEF || stShndx === SHN_ABS) continue;
        if (stType === STT_FUNC) {
            // Function symbols are collected separately (for PC/LR symbolization in fault analysis and size ranking),
            // with the Thumb bit cleared
            const name = readCStr(strtab.offset, stName);
            const address = (stValue & ~1) >>> 0;
            // Different compilation units may have same-named static functions; only entries with the same name and
            // address are duplicates.
            const key = `${name}\0${address}`;
            if (!name || seenFuncs.has(key)) continue;
            seenFuncs.set(key, { name, address, size: stSize >>> 0 });
            continue;
        }
        // Data objects (variables) and functions only
        if (stType !== STT_OBJECT && !(stType === STT_NOTYPE && isUntypedLocalData(stInfo, stShndx, stValue, stSize)))
            continue;
        const name = readCStr(strtab.offset, stName);
        if (!name || (stType === STT_NOTYPE && name.startsWith("$")) || stValue === 0) continue;
        const local = stInfo >> 4 === STB_LOCAL;
        const entry = {
            name,
            address: stValue >>> 0,
            size: stSize >>> 0,
            ...(local && objectFile ? { objectFile } : {})
        };
        const group = seen.get(name);
        if (!group) seen.set(name, [entry]);
        // Same-named internal-linkage variables of different compilation units are all kept and qualified by
        // compilation unit afterwards; only aliases with the same address and size are dropped.
        else if (!group.some((other) => other.address === entry.address && other.size === entry.size))
            group.push(entry);
    }
    const symbols = qualifySameNameSymbols(Array.from(seen.values()).flat());
    const functions = Array.from(seenFuncs.values())
        .filter((s) => s.address !== 0)
        .sort((a, b) => a.address - b.address);
    return { symbols, functions, warnings };
}

// Parses ELF32 section headers (name, load address, flags) and program headers for writable-region checks and flash/RAM
// usage. Returns { sections: [{name,type,addr,offset,size,flags}], programHeaders: [{vaddr,paddr,filesz,memsz,flags}] }
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
    const heapStack = linkerHeapStackRange(buf, entries, sections);
    return { sections, programHeaders, ...(heapStack ? { runtimeRegions: [heapStack] } : {}) };
}

// Run-time heap/stack region: newlib `_sbrk` allocates from the linker script's `_end` up to `_estack -
// _Min_Stack_Size`, while the `._user_heap_stack` section only covers `_Min_Heap_Size + _Min_Stack_Size`, so STL
// container storage and objects created with new beyond that lie in no section. Returns { name, start, end } only when
// `_end` is in (or right after) a writable allocated section, `_estack` is within 16 MiB after it, and the range
// overlaps no other allocated section. Used only for pointer targets of runtime objects; it does not widen variable
// address checks or writes.
function linkerHeapStackRange(buf, entries, sections) {
    const SHT_SYMTAB = 2;
    const SHF_WRITE = 1;
    const SHF_ALLOC = 2;
    const symtab = entries.find((s) => s.type === SHT_SYMTAB);
    const strtab = symtab && entries[symtab.link];
    if (!symtab || !strtab || symtab.offset + symtab.size > buf.length || strtab.offset + strtab.size > buf.length)
        return null;
    const wanted = new Set(["_end", "end", "_estack"]);
    const values = new Map();
    const entsize = symtab.entsize || 16;
    const count = entsize >= 16 ? Math.min(Math.floor(symtab.size / entsize), 200000) : 0;
    for (let i = 0; i < count && values.size < wanted.size; i++) {
        const off = symtab.offset + i * entsize;
        const nameOffset = strtab.offset + buf.readUInt32LE(off);
        if (nameOffset >= strtab.offset + strtab.size || buf[off + 14] + buf[off + 15] * 256 === 0) continue;
        const nameEnd = buf.indexOf(0, nameOffset);
        if (nameEnd < 0 || nameEnd - nameOffset > 8) continue;
        const name = buf.toString("latin1", nameOffset, nameEnd);
        if (wanted.has(name) && !values.has(name)) values.set(name, buf.readUInt32LE(off + 4) >>> 0);
    }
    const start = values.get("_end") ?? values.get("end");
    const end = values.get("_estack");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 0x1000000)
        return null;
    const allocated = sections.filter((s) => s.flags & SHF_ALLOC && s.size > 0);
    const owner = allocated.find(
        (s) =>
            (s.flags & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) &&
            start >= s.addr &&
            start <= s.addr + s.size
    );
    // The heap/stack region can only follow a RAM section; a read-only section (flash, constants) inside the range
    // means the symbols are untrustworthy. Writable sections inside it (such as `._user_heap_stack` itself) are the
    // same RAM; ranges reaching another RAM bank are excluded by the 16 MiB limit.
    if (!owner || allocated.some((s) => !(s.flags & SHF_WRITE) && s.addr < end && s.addr + s.size > start)) return null;
    return { name: "heap-stack", start, end };
}

// Finds the function containing an address among function symbols sorted by address; returns { name, offset } or null
function nearestFunction(functions, address) {
    const addr = (Number(address) & ~1) >>> 0;
    if (!Array.isArray(functions) || !functions.length || !Number.isFinite(addr)) return null;
    let best = null;
    for (const fn of functions) {
        if (fn.address > addr) break; // already sorted by address
        best = fn;
    }
    if (!best) return null;
    const offset = addr - best.address;
    // Sized functions must contain the address; unsized ones (assembly symbols) allow at most a 64 KiB offset to avoid
    // matching across regions
    if (best.size > 0 ? offset >= best.size : offset > 0x10000) return null;
    return { name: best.name, displayName: best.displayName || best.name, offset };
}

// Composite type path parsing and decoding

// Parses member paths:
// sensor.x -> { base:'sensor', segments:[{kind:'member',name:'x'}] }
// buf[0] -> { base:'buf', segments:[{kind:'index',index:0}] }
// buf[1:5] -> { base:'buf', segments:[{kind:'range',start:1,end:5}] }
// buf[*] -> { base:'buf', segments:[{kind:'all'}] }
// buf[0].x -> { base:'buf', segments:[{kind:'index',index:0},{kind:'member',name:'x'}] }
// main.c::cfg.mode / 'dir/main.c'::cfg[0] -> base keeps the qualifying prefix as written plus the variable name
// (callers cut the member suffix off it), and scope:{file:'main.c',name:'cfg'} resolves it by compilation unit.
function parseMemberPath(pathStr) {
    const str = String(pathStr || "").trim();
    const scope = variableScope(str);
    if (scope) {
        const inner = parseMemberPath(scope.name);
        if (!inner || variableScope(inner.base)) return null;
        return {
            base: str.slice(0, scope.prefixLength) + inner.base,
            segments: inner.segments,
            scope: { file: scope.file, name: inner.base }
        };
    }
    if (!str || !/^[A-Za-z_]/.test(str)) return null;
    // Matches baseName followed by .member or [index/range/*]. base may be a C++ qualified name (ns::Foo::bar), a
    // template name (Holder<int>::object) or a mangled name (_Z...).
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
            // Member names are @baseN base segments, ? anonymous segments or standard identifiers.
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
            return null; // invalid character
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
    const steps = [];
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
                steps.push(entry);
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
                    steps,
                    pendingPathSpec: { ...pathSpec, segments: pathSpec.segments.slice(index) }
                };
            }
            if (segment.index < 0 || segment.index >= total) return null;
            offset += segment.index * element.byteSize;
            path += "[" + segment.index + "]";
            node = last && !finalExpansion ? element : layoutBranch(symbol, element, path);
            isConst ||= !!current.isConst || !!node.isConst || !!node.compositeLayout?.isConst;
            usedExpansion ||= !!node.expansionRoot;
            steps.push(node);
        } else return null;
        if (!last && !node.compositeLayout && !["struct", "union", "class", "array"].includes(node.kind)) return null;
    }
    return { node, offset, path, isConst, usedExpansion, steps };
}

// A C++ object whose type graph holds pointers or library containers still has
// fixed-offset user members. Accept exactly one non-pointer scalar reached only through
// user-declared by-value members; anything inside a std:: object, an artificial member
// (_vptr) or a library-internal member stays read-only.
function staticRuntimeWriteLeaf(symbol, layout, pathSpec) {
    if (!symbol || !layout || !pathSpec?.segments.length) return null;
    const leaves = expandCompositeLeaves(symbol, layout, pathSpec);
    if (leaves.length !== 1) return null;
    const [leaf] = leaves;
    if (leaf.isPointer || leaf.isReference || leaf.isMemberPointer || leaf.memberRole) return null;
    const leafSpec = parseMemberPath(leaf.path);
    const target = leafSpec && resolveLayoutPath(symbol, layout, leafSpec);
    if (!target || target.pendingPathSpec || target.node.compositeLayout || !target.node.watchType) return null;
    const library = (node) =>
        !!node.memberRole ||
        !!node.stdSummary ||
        !!node.compositeLayout?.stdSummary ||
        isStdType(node.typeName) ||
        isStdType(node.compositeLayout?.typeName);
    if (library(layout) || target.steps.some(library)) return null;
    return leaf;
}

function expandedStaticLeaves(symbol, pathSpec) {
    if (!symbol?.layoutExpansions || !symbol.compositeLayout || !pathSpec?.segments.length) return [];
    const target = resolveLayoutPath(symbol, symbol.compositeLayout, pathSpec);
    return target?.usedExpansion ? expandCompositeLeaves(symbol, symbol.compositeLayout, pathSpec) : [];
}

// Expands the leaf members of a composite variable into a flat list of reads.
// symbol: { name, address, size }
// layout: CompositeLayout (from dwarf.parseCompositeLayout)
// pathSpec: parseMemberPath result (optional; all leaves without it)
// Returns [{ name, path, address, size, type, typeName }]
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

// Decodes raw bytes into a value tree following the layout.
// bytes: Buffer / Uint8Array / number[] (the variable's complete bytes)
// layout: CompositeLayout
// Returns { kind, typeName, members/elements, value? }
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

    // offset is the node's byte offset from the variable's base address, used by the UI and agents to compute member
    // addresses and paths.
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

// Navigates a decoded value tree to the node named by a path spec (parseMemberPath result). Returns a scalar leaf (with
// value/type/offset) or a subtree (struct/union/array), or null when not found. A range segment returns a synthesized
// array subtree containing only the selected elements.
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
            // stay on the current array node
        } else {
            return null;
        }
    }
    return node;
}

// Whether a tree node is a scalar leaf (value/type without members/elements).
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
    qualifySameNameSymbols,
    refineSameNameSymbols,
    createSymbolResolver,
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
    staticRuntimeWriteLeaf,
    SUPPORTED_TYPES
};
