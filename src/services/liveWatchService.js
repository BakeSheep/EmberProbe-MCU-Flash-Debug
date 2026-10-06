"use strict";

// 将多个消费者的观察列表合并为单一原始字节读取计划。
// 同名标量取最大宽度，复合变量按整体内存范围读取。
function buildActiveReadPlan(watchLists, elfSymbols) {
    const byName = new Map();
    const add = (item) => {
        if (!item?.name) return;
        if (item.runtimeLayout) {
            byName.set(item.name, { ...item });
            return;
        }
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
        const size = Number.isInteger(item.bitSize)
            ? Math.ceil((Number(item.bitOffset) + item.bitSize) / 8)
            : elfSymbols.typeByteLength(item.type);
        if (!Number.isSafeInteger(size) || size <= 0 || size > 9) return;
        const prev = byName.get(item.name);
        if (!prev) byName.set(item.name, { name: item.name, address: item.address, size });
        else if (!prev.isComposite && size > prev.size) prev.size = size;
    };
    for (const list of watchLists || []) for (const item of list || []) add(item);
    return Array.from(byName.values());
}

// A fixed composite is already read as a whole. Keep its scalar leaves in history
// before they are selected for drawing, without adding hardware reads.
function buildChartHistoryItems(items, elfSymbols) {
    const byName = new Map();
    for (const item of items || []) {
        if (!item.isComposite || !item.compositeLayout || item.runtimeLayout) continue;
        for (const leaf of elfSymbols.expandCompositeLeaves(item, item.compositeLayout, null))
            byName.set(leaf.path, { ...leaf, name: leaf.path, parentName: item.name, parentAddress: item.address });
    }
    for (const item of items || []) {
        if (item.isComposite) continue;
        const leaf = byName.get(item.name);
        const same = leaf && ["type", "address", "bitOffset", "bitSize"].every((key) => leaf[key] === item[key]);
        byName.set(item.name, same ? { ...leaf, ...item } : item);
    }
    return [...byName.values()];
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
        (valid ? allowed : denied).push(
            item.runtimeLayout
                ? {
                      ...item,
                      runtimeRanges: sections
                          .filter(
                              (section) =>
                                  section.flags & SHF_ALLOC &&
                                  Number.isSafeInteger(section.addr) &&
                                  Number.isSafeInteger(section.size) &&
                                  section.addr > 0 &&
                                  section.size > 0 &&
                                  section.addr + section.size <= 0x100000000
                          )
                          .map((section) => ({ start: section.addr, end: section.addr + section.size }))
                  }
                : item
        );
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

    decodeHistorySamples(samples, time, items, decodedScalars = []) {
        const raw = new Map(samples.map((sample) => [sample.name, sample]));
        const decoded = new Map(decodedScalars.map((sample) => [sample.name, sample]));
        const result = [];
        const selected = [];
        const types = new Map();
        for (const item of items) {
            if (decoded.has(item.name)) {
                result.push(decoded.get(item.name));
                continue;
            }
            let sample = raw.get(item.name);
            if (!sample && item.parentName) {
                const parent = raw.get(item.parentName);
                if (parent) {
                    const offset = item.address - item.parentAddress;
                    const width = Number.isInteger(item.bitSize)
                        ? Math.ceil((Number(item.bitOffset) + item.bitSize) / 8)
                        : this.elfSymbols.typeByteLength(item.type);
                    sample = {
                        name: item.name,
                        t: parent.t,
                        diagnostic: parent.diagnostic,
                        bytes:
                            parent.bytes && offset >= 0 && offset + width <= parent.bytes.length
                                ? parent.bytes.slice(offset, offset + width)
                                : null
                    };
                }
            }
            if (!sample) continue;
            selected.push(sample);
            types.set(item.name, Number.isInteger(item.bitSize) ? item : item.type);
        }
        return result.concat(this.decodeConsumerSamples(selected, time, types, null).scalarSamples);
    }

    decodeConsumerSamples(samples, time, typeMap, compositeMap, latestSamples) {
        const scalarSamples = [];
        const compositeSamples = [];
        const latest = latestSamples || new Map();
        for (const sample of samples || []) {
            if (!typeMap?.has(sample.name) && !compositeMap?.has(sample.name)) continue;
            const sampleTime = Number.isFinite(sample.t) ? sample.t : time;
            if (sample.diagnostic) {
                const decoded = compositeMap?.has(sample.name)
                    ? {
                          name: sample.name,
                          tree: { kind: "class", members: [], partial: true, unavailable: sample.diagnostic.message },
                          diagnostic: sample.diagnostic,
                          t: sampleTime
                      }
                    : {
                          name: sample.name,
                          value: null,
                          valueText: "<unavailable: " + sample.diagnostic.message + ">",
                          diagnostic: sample.diagnostic,
                          t: sampleTime
                      };
                (decoded.tree ? compositeSamples : scalarSamples).push(decoded);
                latest.set(sample.name, decoded);
                continue;
            }
            if (sample.runtimeTree) {
                if (sample.runtimeTree.kind === "scalar") {
                    const decoded = {
                        name: sample.name,
                        value: sample.runtimeTree.value,
                        valueText: sample.runtimeTree.valueText,
                        t: sampleTime
                    };
                    scalarSamples.push(decoded);
                    latest.set(sample.name, decoded);
                } else {
                    const decoded = { name: sample.name, tree: sample.runtimeTree, t: sampleTime };
                    compositeSamples.push(decoded);
                    latest.set(sample.name, decoded);
                }
                continue;
            }
            const composite = compositeMap?.get(sample.name);
            if (composite) {
                const tree = sample.bytes ? this.elfSymbols.decodeComposite(sample.bytes, composite.layout) : null;
                if (tree) {
                    const decoded = { name: sample.name, tree, t: sampleTime };
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
                t: sampleTime
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
    buildChartHistoryItems,
    nextLivePanelId,
    selectFocusedPanel,
    selectPausedDebugReadSession,
    filterRuntimeRamPlan
};
