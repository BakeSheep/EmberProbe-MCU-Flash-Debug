"use strict";

const elf = require("../elfSymbols");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { MAX_TYPE_ALIASES, MAX_COMPOSITE_DEPTH } = require("../dwarf/layoutLimits");
const { RuntimeObjectReader } = require("./runtimeObjectReader");
const { runtimePointerRanges, writableRamSectionRanges } = require("./liveWatchService");
const { validateWritePreconditions } = require("../writePreconditions");

function denied(message) {
    return Object.assign(new Error(message), { code: "WRITE_NOT_ALLOWED" });
}

function runtimeWriteRequests(values, elfResult) {
    if (Array.isArray(values) && values.length > 64)
        throw Object.assign(new Error("At most 64 variables can be written at once"), { code: "INVALID_PARAMS" });
    const resolve = elf.createSymbolResolver(elfResult.symbols, { foldCase: false });
    const requests = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const name = String(value?.name || "").trim();
        const path = elf.parseMemberPath(name);
        if (!path?.segments.length) continue;
        const symbol = resolve(path.base, name);
        const graph = symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout;
        if (!graph || elf.staticRuntimeWriteLeaf(symbol, symbol.compositeLayout, path)) continue;
        const canonical = symbol.name + name.slice(path.base.length);
        if (seen.has(canonical))
            throw Object.assign(new Error(`Variable requested more than once: ${canonical}`), {
                code: "DUPLICATE_VARIABLE"
            });
        seen.add(canonical);
        const raw = value?.value;
        if (!(
            typeof raw === "boolean" ||
            typeof raw === "number" ||
            typeof raw === "bigint" ||
            (typeof raw === "string" && raw.trim())
        ))
            throw Object.assign(new Error(`Invalid write value: ${raw}`), { code: "INVALID_WRITE_VALUE" });
        const item = {
            name: canonical,
            address: symbol.address,
            size: symbol.size,
            runtimeLayout: graph,
            runtimeSegments: path.segments
        };
        requests.push({ requestedName: name, item });
    }
    return requests;
}

function runtimeWritableRanges(memory) {
    const sections = memory?.sections || [];
    const regions = (memory?.runtimeRegions || []).filter(
        (region) =>
            Number.isSafeInteger(region.start) &&
            Number.isSafeInteger(region.end) &&
            region.start > 0 &&
            region.end > region.start &&
            region.end <= 0x100000000 &&
            !sections.some(
                (section) =>
                    section.flags & 2 &&
                    !(section.flags & 1) &&
                    section.addr < region.end &&
                    region.start < section.addr + section.size
            )
    );
    return [...writableRamSectionRanges(sections), ...regions];
}

// Reuse the reader's ABI/container traversal, while retaining write qualifications.
// Library internals are traversed only by storage(); user paths select semantic elements.
class RuntimeWriteReader extends RuntimeObjectReader {
    type(id) {
        let isConst = false;
        for (let depth = 0; depth < MAX_TYPE_ALIASES; depth++) {
            const node = this.graph.types[id];
            if (!node) break;
            isConst ||= !!node.isConst;
            if (node.kind !== "alias") return { ...node, id, isConst };
            id = node.target;
        }
        throw denied("Dynamic write type is unavailable or cyclic");
    }
    async dynamic(object) {
        const isConst = !!object.writeConst || this.type(object.type).isConst;
        const resolved = await super.dynamic(object);
        return { ...resolved, writeConst: isConst || this.type(resolved.type).isConst };
    }
    async field(object, name, depth = 0, internal = false) {
        if (!internal && this.type(object.type).kind === "union")
            throw denied("Union active member identity is unavailable");
        return super.field(object, name, depth, internal);
    }
    async member(object, field) {
        const result = await super.member(object, field);
        return {
            ...result,
            writeConst: !!object.writeConst || this.type(object.type).isConst || this.type(result.type).isConst,
            writeForbidden: !!object.writeForbidden || !!field.memberRole || Number.isInteger(field.bitSize)
        };
    }
    async selectTarget() {
        const segments = this.item.runtimeSegments || [];
        if (segments.length > MAX_COMPOSITE_DEPTH) throw denied("Dynamic write path is too deep");
        let object = {
            ...(await this.dynamic({ address: this.item.address, type: this.graph.root })),
            writeConst: this.type(this.graph.root).isConst
        };
        for (const segment of segments) {
            if (object.writeForbidden) throw denied("Writing internal members or bitfields is not supported");
            let type = this.type(object.type);
            let unwrappedRef = false;
            while (type.kind === "reference") {
                if (type.pointerTarget && type.pointerTarget !== "data")
                    throw denied("Opaque pointer target is not writable");
                const targetConst = this.type(type.target).isConst;
                object = await this.dereference(object);
                type = this.type(object.type);
                object.writeConst = targetConst || !!object.writeConst || type.isConst;
                unwrappedRef = true;
            }
            if (type.kind === "pointer") {
                if (segment.kind !== "dereference" && segment.name !== "value")
                    throw denied("Pointer writes require an explicit dereference path");
                if (type.pointerTarget && type.pointerTarget !== "data")
                    throw denied("Opaque pointer target is not writable");
                const targetConst = this.type(type.target).isConst;
                object = await this.dereference(object);
                // Const pointer storage does not make a mutable pointee const.
                object.writeConst = targetConst || !!object.writeConst || this.type(object.type).isConst;
                continue;
            }
            if (unwrappedRef && segment.kind === "dereference") continue;
            if (unwrappedRef && segment.kind === "member" && segment.name === "value" && !type.stl) {
                if (type.kind === "scalar" || type.kind === "array") continue;
                if (type.kind === "class") {
                    try {
                        object = await this.field(object, "value");
                    } catch (error) {
                        if (error.code !== "LIVE_MEMBER_MISSING") throw error;
                    }
                    continue;
                }
            }
            if (segment.kind === "dereference") throw denied("Cannot dereference this write target");
            type = this.type(object.type);
            const storage = await this.storage(object);
            if (storage) {
                if (type.stl === "basic_string") throw denied("String storage writes are not supported");
                const position =
                    segment.kind === "index"
                        ? segment.index
                        : storage.named && segment.name === "value"
                          ? 0
                          : storage.labels?.indexOf(segment.name);
                if (!Number.isSafeInteger(position) || position < 0 || position >= storage.count)
                    throw denied("Dynamic write element is outside the current container bounds");
                const isConst = !!object.writeConst || type.isConst || /^(?:unordered_)?(?:multi)?set$/.test(type.stl);
                const selected = await storage.at(position);
                object = {
                    ...selected,
                    writeConst: isConst || !!selected.writeConst || this.type(selected.type).isConst,
                    writeForbidden: !!object.writeForbidden || Number.isInteger(selected.field?.bitSize)
                };
            } else if (type.kind === "union") throw denied("Union active member identity is unavailable");
            else if (segment.kind === "member") object = await this.field(object, segment.name);
            else if (
                segment.kind === "index" &&
                type.kind === "array" &&
                Number.isSafeInteger(segment.index) &&
                segment.index >= 0 &&
                segment.index < type.count
            )
                object = {
                    ...object,
                    address: object.address + segment.index * this.size(type.target),
                    type: type.target,
                    writeConst: !!object.writeConst || type.isConst
                };
            else throw denied("Write target must identify one bounded scalar leaf");
        }
        const type = this.type(object.type);
        if (
            type.kind !== "scalar" ||
            object.writeForbidden ||
            object.writeConst ||
            type.isConst ||
            type.isMemberPointer
        )
            throw denied("Dynamic write target must be a mutable scalar leaf");
        if (!elf.SUPPORTED_TYPES.includes(type.watchType) || type.enumEncodingInferred)
            throw Object.assign(new Error("Dynamic write encoding is unavailable from DWARF"), {
                code: "WRITE_TYPE_UNKNOWN"
            });
        const size = this.size(object.type);
        if (size !== elf.typeByteLength(type.watchType) || !this.inRange(object.address, size))
            throw denied("Dynamic write address or type width is invalid");
        return {
            name: this.item.name,
            address: object.address,
            type: type.watchType,
            size,
            isBoolean: !!type.isBoolean,
            runtimeWrite: true
        };
    }
}

async function resolveRuntimeWriteTargets(requests, elfResult, read, guard = () => {}, clock = SYSTEM_CLOCK) {
    const targets = new Map();
    const descriptors = new Map();
    const writable = runtimeWritableRanges(elfResult.memory);
    const ranges = runtimePointerRanges(elfResult.memory.sections, elfResult.memory.runtimeRegions);
    const budget = { bytes: 0, commands: 0, deadline: clock.now() + 1000 };
    for (const request of requests) {
        const item = { ...request.item, runtimeRanges: ranges };
        if (
            !elfResult.memory.sections.some(
                (section) =>
                    section.flags & 2 &&
                    item.size > 0 &&
                    item.address >= section.addr &&
                    item.address + item.size <= section.addr + section.size
            )
        )
            throw denied("Dynamic write root is outside allocated ELF storage");
        const reader = new RuntimeWriteReader(item, read, guard, budget, { clock });
        const target = await reader.selectTarget();
        if (!writable.some((range) => target.address >= range.start && target.address + target.size <= range.end))
            throw denied("Dynamic write target is outside verified writable RAM");
        for (const span of reader.verificationSpans()) {
            reader.verificationBudget.bytes -= span.size;
            reader.verificationBudget.commands--;
            if (reader.changedInSpan(span, await reader.memory(span.address, span.size, true)).length)
                throw Object.assign(new Error("Dynamic object moved while resolving the write path"), {
                    code: "WRITE_TARGET_CHANGED"
                });
        }
        for (const [address, bytes] of reader.descriptors) {
            for (const existing of descriptors.values()) {
                const start = Math.max(address, existing.address);
                const end = Math.min(address + bytes.length, existing.address + existing.bytes.length);
                for (let at = start; at < end; at++) {
                    if (bytes[at - address] !== existing.bytes[at - existing.address])
                        throw Object.assign(new Error("Dynamic write paths refer to different snapshots"), {
                            code: "WRITE_TARGET_CHANGED"
                        });
                }
            }
            descriptors.set(address + ":" + bytes.length, { address, bytes: Array.from(bytes) });
        }
        targets.set(request.requestedName, target);
    }
    guard();
    if (clock.now() > budget.deadline)
        throw Object.assign(new Error("Dynamic write planning exceeded its time budget"), {
            code: "LIVE_READ_BUDGET_EXCEEDED"
        });
    return { targets, checks: [...descriptors.values()].sort((a, b) => a.address - b.address) };
}

function validateRuntimeWritePlan(plan) {
    const checks = plan.runtimeChecks || [];
    validateWritePreconditions(checks, plan.items);
    return plan;
}

module.exports = { runtimeWriteRequests, resolveRuntimeWriteTargets, runtimeWritableRanges, validateRuntimeWritePlan };
