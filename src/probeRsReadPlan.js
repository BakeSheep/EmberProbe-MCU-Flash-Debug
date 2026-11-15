"use strict";
const { compileReadBatches, validateManagedReadPlan } = require("./liveWatchReadPlan");
const { MultiRatePlan } = require("./services/multiRatePlan");

function nativeRecipe(items, ranges) {
    validateManagedReadPlan(items);
    for (const item of items) {
        if (typeof item.name !== "string" || !item.name || item.name.length > 1024)
            throw Object.assign(new Error("Invalid native watch name"), { code: "INVALID_VARIABLE" });
        if (item.runtimeLayout)
            throw Object.assign(new Error("Use OpenOCD for variables that require runtime pointer or STL traversal"), {
                code: "PROBE_RS_LAYOUT_UNSUPPORTED"
            });
        if (!ranges.some((range) => item.address >= range.start && item.address + item.size <= range.end))
            throw Object.assign(new Error("Native sampling requires writable ELF RAM"), {
                code: "LIVE_ADDRESS_NOT_RAM"
            });
    }
    const units = compileReadBatches(items, ranges, true, 0, 4).flat();
    let byteCount = 0;
    const groups = units.map((unit) => {
        const group = { address: unit.start, count: unit.byteCount, offset: byteCount };
        byteCount += unit.byteCount;
        return group;
    });
    if (byteCount > 4096 || groups.length > 64)
        throw Object.assign(new Error("Native read plan exceeds 4096 bytes / 64 ranges"), {
            code: "LIVE_READ_BUDGET_EXCEEDED"
        });
    const slices = items.map((item) => ({
        name: item.name,
        size: item.size,
        parts: groups.flatMap((group) => {
            const start = Math.max(item.address, group.address);
            const end = Math.min(item.address + item.size, group.address + group.count);
            return end > start
                ? [{ source: group.offset + start - group.address, target: start - item.address, count: end - start }]
                : [];
        })
    }));
    return { groups, slices, byteCount };
}

function nativePlan(plan) {
    const rate = new MultiRatePlan(plan);
    const ranges = plan.ramSectionRanges || [];
    const byName = new Map(rate.items.map((item) => [item.name, item]));
    const select = (items) => [...new Set(items.map((item) => item.name))].map((name) => byName.get(name));
    const recipes = [
        nativeRecipe([], ranges),
        nativeRecipe(select(rate.graphItems), ranges),
        nativeRecipe(select(rate.sidebarItems), ranges),
        nativeRecipe(rate.items, ranges)
    ];
    return { rate, recipes, ranges };
}

function unpackRecipe(recipe, bytes, t) {
    if (bytes.length !== recipe.byteCount) throw new Error("Native payload does not match the active plan");
    return recipe.slices.map((item) => {
        const output = Buffer.alloc(item.size);
        for (const part of item.parts) bytes.copy(output, part.target, part.source, part.source + part.count);
        return { name: item.name, bytes: Array.from(output), t };
    });
}
module.exports = { nativeRecipe, nativePlan, unpackRecipe };
