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

// —— 复合类型路径解析与解码 ——

// 解析成员路径：sensor.x → { base:'sensor', segments:[{kind:'member',name:'x'}] }
// buf[0] → { base:'buf', segments:[{kind:'index',index:0}] }
// buf[1:5] → { base:'buf', segments:[{kind:'range',start:1,end:5}] }
// buf[*] → { base:'buf', segments:[{kind:'all'}] }
// buf[0].x → { base:'buf', segments:[{kind:'index',index:0},{kind:'member',name:'x'}] }
function parseMemberPath(pathStr) {
    const str = String(pathStr || '').trim();
    if (!str) return null;
    // 匹配 baseName 后跟 .member 或 [index/range/*]
    const m = str.match(/^([a-zA-Z_]\w*)/);
    if (!m) return null;
    const base = m[1];
    const rest = str.slice(base.length);
    const segments = [];
    let pos = 0;
    while (pos < rest.length) {
        if (rest[pos] === '.') {
            pos++;
            const nameMatch = rest.slice(pos).match(/^([a-zA-Z_]\w*)/);
            if (!nameMatch) return null;
            segments.push({ kind: 'member', name: nameMatch[1] });
            pos += nameMatch[1].length;
        } else if (rest[pos] === '[') {
            pos++;
            const end = rest.indexOf(']', pos);
            if (end < 0) return null;
            const inner = rest.slice(pos, end).trim();
            if (inner === '*') {
                segments.push({ kind: 'all' });
            } else if (inner.includes(':')) {
                const parts = inner.split(':');
                if (parts.length !== 2 || !/^\d*$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
                const start = parts[0] === '' ? 0 : Number(parts[0]);
                const endIdx = Number(parts[1]);
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endIdx) || endIdx <= start) return null;
                segments.push({ kind: 'range', start, end: endIdx });
            } else {
                if (!/^\d+$/.test(inner)) return null;
                const idx = Number(inner);
                if (!Number.isSafeInteger(idx)) return null;
                segments.push({ kind: 'index', index: idx });
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
    const baseAddr = Number(symbol.address) >>> 0;
    const leaves = [];

    function walk(currentLayout, currentOffset, currentPath, depth) {
        if (depth > 10 || !currentLayout) return;
        if (currentLayout.kind === 'struct' || currentLayout.kind === 'union') {
            for (const m of (currentLayout.members || [])) {
                const memberPath = currentPath + '.' + (m.name || '?');
                const memberOffset = currentOffset + (m.offset || 0);
                if (m.compositeLayout) {
                    walk(m.compositeLayout, memberOffset, memberPath, depth + 1);
                } else if (m.watchType) {
                    leaves.push({
                        name: symbol.name,
                        path: memberPath,
                        address: (baseAddr + memberOffset) >>> 0,
                        size: m.byteSize || typeByteLength(m.watchType),
                        type: m.watchType,
                        typeName: m.typeName || ''
                    });
                }
            }
        } else if (currentLayout.kind === 'array') {
            const elemType = currentLayout.elementType || {};
            const dims = currentLayout.dimensions || [];
            const total = currentLayout.totalElements || 0;
            const elemSize = elemType.byteSize || 0;
            // 确定要展开的元素范围
            let rangeStart = 0, rangeEnd = total;
            if (pathSpec && pathSpec.segments.length > 0) {
                const seg = pathSpec.segments[0];
                const remainingSegments = pathSpec.segments.slice(1);
                if (seg.kind === 'index') {
                    if (seg.index < 0 || seg.index >= total) return;
                    rangeStart = seg.index;
                    rangeEnd = seg.index + 1;
                } else if (seg.kind === 'range') {
                    if (seg.start < 0 || seg.end <= seg.start || seg.end > total) return;
                    rangeStart = seg.start;
                    rangeEnd = seg.end;
                } else if (seg.kind === 'all') {
                    // 全部
                }
                // 如果有剩余路径段，说明是嵌套访问（如 buf[0].x）
                if (remainingSegments.length > 0 && elemType.kind === 'struct') {
                    // 对范围内的每个元素递归展开
                    const subPath = { base: symbol.name, segments: remainingSegments };
                    for (let i = rangeStart; i < rangeEnd; i++) {
                        const elemOffset = currentOffset + i * elemSize;
                        const elemPath = currentPath + '[' + i + ']';
                        if (elemType.kind === 'struct' || elemType.kind === 'union') {
                            // 需要元素类型的 layout，但数组的 elementType 不含成员信息
                            // 这种情况下 compositeLayout 的 elementType 是标量信息
                            // 嵌套复合数组的处理依赖 compositeLayout 中的成员信息
                        }
                    }
                    return;
                }
            }
            // 展开标量元素
            if (elemType.compositeLayout) {
                for (let i = rangeStart; i < rangeEnd; i++) {
                    walk(elemType.compositeLayout, currentOffset + i * elemSize, currentPath + '[' + i + ']', depth + 1);
                }
            } else if (elemType.watchType) {
                for (let i = rangeStart; i < rangeEnd; i++) {
                    leaves.push({
                        name: symbol.name,
                        path: currentPath + '[' + i + ']',
                        address: (baseAddr + currentOffset + i * elemSize) >>> 0,
                        size: elemSize,
                        type: elemType.watchType,
                        typeName: elemType.typeName || ''
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
        for (const seg of pathSpec.segments) {
            if (seg.kind === 'member' && (currentLayout.kind === 'struct' || currentLayout.kind === 'union')) {
                const member = (currentLayout.members || []).find(m => m.name === seg.name);
                if (!member) return []; // 成员不存在
                currentOffset += member.offset || 0;
                currentPath += '.' + member.name;
                if (member.compositeLayout) {
                    currentLayout = member.compositeLayout;
                } else {
                    // 到达标量叶子
                    return [{
                        name: symbol.name,
                        path: currentPath,
                        address: (baseAddr + currentOffset) >>> 0,
                        size: member.byteSize || typeByteLength(member.watchType),
                        type: member.watchType,
                        typeName: member.typeName || ''
                    }];
                }
            } else if ((seg.kind === 'index' || seg.kind === 'range' || seg.kind === 'all') && currentLayout.kind === 'array') {
                const elemSize = currentLayout.elementType ? currentLayout.elementType.byteSize : 0;
                if (seg.kind === 'index') {
                    const total = Number(currentLayout.totalElements) || 0;
                    if (seg.index < 0 || seg.index >= total) return [];
                    currentOffset += seg.index * elemSize;
                    currentPath += '[' + seg.index + ']';
                    if (currentLayout.elementType && currentLayout.elementType.compositeLayout) {
                        currentLayout = currentLayout.elementType.compositeLayout;
                        continue;
                    }
                    if (currentLayout.elementType && currentLayout.elementType.kind !== 'struct' && currentLayout.elementType.kind !== 'union' && currentLayout.elementType.kind !== 'array') {
                        return [{
                            name: symbol.name,
                            path: currentPath,
                            address: (baseAddr + currentOffset) >>> 0,
                            size: elemSize,
                            type: currentLayout.elementType.watchType,
                            typeName: currentLayout.elementType.typeName || ''
                        }];
                    }
                    return [];
                }
                // range / all：展开为多个叶子
                if (seg.kind === 'range') {
                    const total = Number(currentLayout.totalElements) || 0;
                    if (seg.start < 0 || seg.end <= seg.start || seg.end > total) return [];
                }
                break; // 跳出循环，交给 walk 处理
            } else {
                return []; // 路径不匹配
            }
        }
        // 如果导航后到达复合类型，展开其全部叶子
        walk(currentLayout, currentOffset, currentPath, 0);
    } else {
        walk(layout, 0, symbol.name, 0);
    }
    return leaves;
}

// 从原始字节按布局解码为树形值结构
// bytes: Buffer / Uint8Array / number[]（变量的完整字节）
// layout: CompositeLayout
// 返回 { kind, typeName, members/elements, value? }
function decodeComposite(bytes, layout) {
    if (!bytes || !layout) return null;
    const src = Uint8Array.from(bytes);

    function decodeScalar(offset, type) {
        const width = typeByteLength(type);
        if (offset < 0 || offset + width > src.length) return null;
        const view = new DataView(src.buffer, src.byteOffset + offset, width);
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

    // offset 为该节点相对变量基址的绝对字节偏移，供 UI/Agent 计算成员地址与定位路径。
    function decodeLayout(offset, lyt) {
        if (!lyt) return null;
        if (lyt.kind === 'struct' || lyt.kind === 'union') {
            const members = [];
            for (const m of (lyt.members || [])) {
                const mOff = offset + (m.offset || 0);
                if (m.compositeLayout) {
                    members.push({ name: m.name, ...decodeLayout(mOff, m.compositeLayout) });
                } else if (m.watchType) {
                    members.push({ name: m.name, offset: mOff, value: decodeScalar(mOff, m.watchType), type: m.watchType, typeName: m.typeName || '' });
                }
            }
            return { kind: lyt.kind, typeName: lyt.typeName, byteSize: lyt.byteSize, offset, members };
        }
        if (lyt.kind === 'array') {
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
                    elements.push({ index: i, offset: eOff, value: decodeScalar(eOff, elemType.watchType), type: elemType.watchType });
                }
            }
            return { kind: 'array', typeName: lyt.typeName, byteSize: lyt.byteSize, offset, elementType: elemType, dimensions: lyt.dimensions, elements };
        }
        return null;
    }

    return decodeLayout(0, layout);
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
        if (seg.kind === 'member') {
            if (!Array.isArray(node.members)) return null;
            node = node.members.find(m => m.name === seg.name) || null;
        } else if (seg.kind === 'index') {
            if (!Array.isArray(node.elements)) return null;
            node = node.elements.find(e => e.index === seg.index) || null;
        } else if (seg.kind === 'range') {
            if (!Array.isArray(node.elements)) return null;
            const els = node.elements.filter(e => e.index >= seg.start && e.index < seg.end);
            node = {
                kind: 'array', typeName: node.typeName, elementType: node.elementType,
                dimensions: node.dimensions, offset: els.length ? els[0].offset : node.offset, elements: els
            };
        } else if (seg.kind === 'all') {
            // 停留在当前数组节点
        } else {
            return null;
        }
    }
    return node;
}

// 判断一个树节点是否为标量叶子（含 value/type，无 members/elements 子结构）。
function isScalarLeafNode(node) {
    return !!node && Object.prototype.hasOwnProperty.call(node, 'value')
        && !Object.prototype.hasOwnProperty.call(node, 'members')
        && !Object.prototype.hasOwnProperty.call(node, 'elements');
}

module.exports = { parseElfSymbols, decodeValue, decodeComposite, navigateCompositeTree, isScalarLeafNode, defaultType, typeByteLength, resolveVariableRequests, parseMemberPath, expandCompositeLeaves, SUPPORTED_TYPES };
