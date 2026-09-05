"use strict";

// 将多个消费者的观察列表合并为单一原始字节读取计划。
// 同名标量取最大宽度，复合变量按整体内存范围读取。
function buildActiveReadPlan(watchLists, elfSymbols) {
    const byName = new Map();
    const add = (item) => {
        if (!item?.name) return;
        if (item.isComposite && item.compositeLayout) {
            const sym = { name: item.name, address: item.address, size: item.size };
            const leaves = elfSymbols.expandCompositeLeaves(sym, item.compositeLayout, null);
            if (!leaves.length) return;
            const totalSize =
                Number(item.size) ||
                leaves.reduce((max, leaf) => Math.max(max, leaf.address - (Number(item.address) >>> 0) + leaf.size), 0);
            const prev = byName.get(item.name);
            if (!prev || totalSize > prev.size || !prev.isComposite) {
                byName.set(item.name, { name: item.name, address: item.address, size: totalSize, isComposite: true });
            }
            return;
        }
        const size = elfSymbols.typeByteLength(item.type);
        const prev = byName.get(item.name);
        if (!prev) byName.set(item.name, { name: item.name, address: item.address, size });
        else if (!prev.isComposite && size > prev.size) prev.size = size;
    };
    for (const list of watchLists || []) for (const item of list || []) add(item);
    return Array.from(byName.values());
}

function filterRuntimeRamPlan(items, sections) {
    const SHF_WRITE = 1;
    const SHF_ALLOC = 2;
    const ranges = (Array.isArray(sections) ? sections : [])
        .filter(
            (section) =>
                (Number(section.flags) & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) &&
                Number(section.size) > 0
        )
        .map((section) => ({
            name: section.name || "",
            start: Number(section.addr),
            end: Number(section.addr) + Number(section.size)
        }))
        .filter(
            (range) =>
                Number.isSafeInteger(range.start) &&
                Number.isSafeInteger(range.end) &&
                range.start >= 0 &&
                range.end <= 0x100000000 &&
                range.end > range.start
        );
    const allowed = [];
    const denied = [];
    for (const item of Array.isArray(items) ? items : []) {
        const address = Number(item?.address);
        const size = Number(item?.size);
        const end = address + size;
        const valid =
            Number.isInteger(address) &&
            Number.isInteger(size) &&
            address >= 0 &&
            size > 0 &&
            Number.isSafeInteger(end) &&
            end <= 0x100000000 &&
            ranges.some((range) => address >= range.start && end <= range.end);
        (valid ? allowed : denied).push(item);
    }
    return { allowed, denied, ranges };
}

function nextLivePanelId(entries) {
    const used = entries instanceof Map ? entries : new Map((entries || []).map((id) => [Number(id), true]));
    let id = 1;
    while (used.has(id)) id++;
    return id;
}

function selectFocusedPanel(entries) {
    let focused = null;
    const values = entries instanceof Map ? entries.values() : entries || [];
    for (const entry of values) if (!focused || Number(entry.focusOrder) > Number(focused.focusOrder)) focused = entry;
    return focused;
}

function selectPausedDebugReadSession(debugBridge) {
    if (debugBridge?.agentStatus?.().state !== "paused") return null;
    return {
        readOnce(items) {
            return debugBridge.readPausedItems(items);
        }
    };
}

// 单消费者解码层：同一份原始字节可按每个面板自己的类型/复合布局分别解码。
class LiveWatchService {
    constructor(elfSymbols) {
        this.elfSymbols = elfSymbols;
        this.latestSidebarSamples = new Map();
    }

    decodeConsumerSamples(samples, time, typeMap, compositeMap, latestSamples) {
        const scalarSamples = [];
        const compositeSamples = [];
        const latest = latestSamples || new Map();
        for (const sample of samples || []) {
            const composite = compositeMap?.get(sample.name);
            if (composite) {
                const tree = sample.bytes ? this.elfSymbols.decodeComposite(sample.bytes, composite.layout) : null;
                if (tree) {
                    const decoded = { name: sample.name, tree, t: time };
                    compositeSamples.push(decoded);
                    latest.set(sample.name, decoded);
                }
                continue;
            }
            const typeSpec = typeMap?.get(sample.name);
            if (!typeSpec) continue;
            const type = typeof typeSpec === "string" ? typeSpec : typeSpec.type;
            const bitfield = typeof typeSpec === "object" && Number.isInteger(typeSpec.bitSize);
            const bitValue =
                bitfield && sample.bytes
                    ? this.elfSymbols.decodeBitfieldValue(sample.bytes, type, typeSpec.bitOffset, typeSpec.bitSize)
                    : null;
            const decoded = {
                name: sample.name,
                value: bitValue
                    ? bitValue.value
                    : sample.bytes
                      ? this.elfSymbols.decodeValue(sample.bytes, type)
                      : null,
                valueText: bitValue
                    ? bitValue.valueText
                    : sample.bytes
                      ? this.elfSymbols.decodeValueText(sample.bytes, type)
                      : null,
                t: time
            };
            scalarSamples.push(decoded);
            latest.set(sample.name, decoded);
        }
        return { scalarSamples, compositeSamples };
    }
}

module.exports = {
    LiveWatchService,
    buildActiveReadPlan,
    nextLivePanelId,
    selectFocusedPanel,
    selectPausedDebugReadSession,
    filterRuntimeRamPlan
};
