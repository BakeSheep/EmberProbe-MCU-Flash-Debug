"use strict";

const elf = require("../elfSymbols");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { MAX_COMPOSITE_DEPTH } = require("../dwarf/layoutLimits");
const { RuntimeObjectReader } = require("./runtimeObjectReader");
const { runtimePointerRanges, runtimeWritableRanges } = require("./liveWatchService");
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

async function selectWriteTarget(reader) {
    const segments = reader.item.runtimeSegments || [];
    if (segments.length > MAX_COMPOSITE_DEPTH) throw denied("Dynamic write path is too deep");
    const root = await reader.dynamic({ address: reader.item.address, type: reader.graph.root });
    const object = await reader.select(root, segments, true);
    const type = reader.type(object.type);
    const restriction = reader.writeRestriction(object, type);
    if (restriction === "type")
        throw Object.assign(new Error("Dynamic write encoding is unavailable"), { code: "WRITE_TYPE_UNKNOWN" });
    if (restriction) throw denied("Dynamic write target must be a mutable scalar leaf in writable RAM");
    return {
        name: reader.item.name,
        address: object.address,
        type: type.watchType,
        typeName: type.typeName,
        size: reader.size(object.type),
        isBoolean: !!type.isBoolean,
        runtimeWrite: true
    };
}

async function resolveRuntimeWriteTargets(requests, elfResult, read, guard = () => {}, clock = SYSTEM_CLOCK) {
    const targets = new Map();
    const descriptors = new Map();
    const writable = runtimeWritableRanges(elfResult.memory);
    const ranges = runtimePointerRanges(elfResult.memory.sections, elfResult.memory.runtimeRegions);
    const budget = { bytes: 0, commands: 0, deadline: clock.now() + 1000 };
    for (const request of requests) {
        const item = { ...request.item, runtimeRanges: ranges, runtimeWriteRanges: writable };
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
        const reader = new RuntimeObjectReader(item, read, guard, budget, { clock });
        const target = await selectWriteTarget(reader);
        for (const span of reader.verificationSpans()) {
            reader.verificationBudget.bytes -= span.size;
            reader.verificationBudget.commands--;
            if (reader.changedInSpan(span, await reader.memory(span.address, span.size, true)).length)
                throw Object.assign(new Error("Dynamic object moved while resolving the write path"), {
                    code: "WRITE_TARGET_CHANGED",
                    details: { written: false, writtenItems: 0, verified: false }
                });
        }
        for (const [address, bytes] of reader.descriptors) {
            for (const existing of descriptors.values()) {
                const start = Math.max(address, existing.address);
                const end = Math.min(address + bytes.length, existing.address + existing.bytes.length);
                for (let at = start; at < end; at++) {
                    if (bytes[at - address] !== existing.bytes[at - existing.address])
                        throw Object.assign(new Error("Dynamic write paths refer to different snapshots"), {
                            code: "WRITE_TARGET_CHANGED",
                            details: { written: false, writtenItems: 0, verified: false }
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

module.exports = { runtimeWriteRequests, resolveRuntimeWriteTargets, validateRuntimeWritePlan };
