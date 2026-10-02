"use strict";

const { clampInteger } = require("./validation");
const hex = (value) => `0x${value.toString(16).toUpperCase()}`;

function unionBytes(ranges) {
    const sorted = ranges.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0]);
    let total = 0,
        end = -1;
    for (const [start, next] of sorted) {
        total += Math.max(0, next - Math.max(start, end));
        end = Math.max(end, next);
    }
    return total;
}

function regionKind(name, overrides) {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (/ram|tcm|ccm|ddr/i.test(name)) return "ram";
    if (/flash|rom|xip|qspi|ospi/i.test(name)) return "flash";
    return "other";
}

function loadAddress(section, headers) {
    const hits = headers.filter(
        (ph) =>
            ph.type === 1 &&
            section.addr >= ph.vaddr &&
            section.addr + section.size <= ph.vaddr + ph.memsz &&
            section.offset >= ph.offset &&
            section.offset + section.size <= ph.offset + ph.filesz &&
            section.addr - ph.vaddr === section.offset - ph.offset
    );
    const addresses = new Set(hits.map((ph) => ph.paddr + section.addr - ph.vaddr));
    if (addresses.size !== 1) return null;
    const address = [...addresses][0];
    return address >= 0 && address + section.size <= 0x100000000 ? address : null;
}

function topSymbols(snapshot, top) {
    const sections = snapshot.memory.sections;
    return [
        ...(snapshot.functions || []).map((s) => ({ ...s, kind: "function" })),
        ...(snapshot.symbols || []).map((s) => ({ ...s, kind: "object" }))
    ]
        .filter((s) => s.size > 0)
        .sort((a, b) => b.size - a.size)
        .slice(0, clampInteger(top, 20, 1, 100))
        .map((s) => ({
            name: s.name,
            displayName: s.displayName || s.name,
            kind: s.kind,
            size: s.size,
            address: hex(s.address),
            section:
                sections.find((item) => item.flags & 2 && s.address >= item.addr && s.address < item.addr + item.size)
                    ?.name || ""
        }));
}

function analyzeMemory(snapshot, definitions = [], overrides = {}, initialDiagnostics = []) {
    const diagnostics = [...initialDiagnostics];
    const warn = (code, message) => diagnostics.push({ code, message });
    const regions = definitions.map((region) => ({
        ...region,
        type: regionKind(region.name, overrides),
        sections: [],
        ranges: [],
        complete: true
    }));
    const categories = {
        flash: { total: 0, sections: [], estimated: !regions.length, ranges: [] },
        ram: { total: 0, sections: [], estimated: !regions.length, ranges: [] }
    };
    for (const region of regions) {
        if (region.type === "other") warn("REGION_KIND_UNKNOWN", `Specify memory.regionKinds for ${region.name}`);
    }
    const find = (address, size, name) => {
        const hits = regions.filter((r) => address < r.origin + r.capacity && address + size > r.origin);
        if (hits.length === 1 && address >= hits[0].origin) {
            if (address + size > hits[0].origin + hits[0].capacity) {
                warn("MEMORY_REGION_OVERFLOW", `${name} exceeds ${hits[0].name}`);
            }
            return hits[0];
        }
        if (hits.length) {
            for (const hit of hits) hit.complete = false;
            warn("MEMORY_REGION_AMBIGUOUS", `${name} crosses or overlaps memory region boundaries`);
        } else if (regions.length)
            warn("MEMORY_SECTION_UNMAPPED", `${name} at ${hex(address)} is outside known regions`);
        return null;
    };
    const record = (section, address, role, knownLoad = true, resolvedLoad = null) => {
        const region = find(address, section.size, section.name);
        const entry = {
            name: section.name,
            address: hex(address),
            runtimeAddress: hex(section.addr),
            loadAddress: resolvedLoad == null ? null : hex(resolvedLoad),
            size: section.size,
            role,
            region: region?.name || null,
            loadAddressKnown: knownLoad
        };
        if (region) {
            region.sections.push(entry);
            region.ranges.push([address, address + section.size]);
        }
        if (region && region.type !== "other") {
            const category = categories[region.type];
            category.sections.push(entry);
            category.ranges.push([address, address + section.size]);
        } else {
            // Preserve the previous API's heuristic totals when the physical layout is unknown.
            const kind = role === "load" ? "flash" : section.flags & 1 ? "ram" : null;
            if (kind) {
                categories[kind].sections.push(entry);
                categories[kind].ranges.push([address, address + section.size]);
                categories[kind].estimated = true;
            }
            if (role === "runtime" && !(section.flags & 1)) categories.ram.estimated = true;
        }
    };
    for (const section of snapshot.memory.sections) {
        if (!(section.flags & 2) || !section.size) continue;
        if (section.addr + section.size > 0x100000000) {
            warn("ELF_SECTION_RANGE_INVALID", `Invalid allocated range: ${section.name}`);
            categories.flash.estimated = categories.ram.estimated = true;
            continue;
        }
        const lma = section.type === 8 ? null : loadAddress(section, snapshot.memory.programHeaders);
        record(section, section.addr, "runtime", lma !== null || section.type === 8, lma);
        if (section.type === 8) continue;
        if (lma === null) {
            warn("ELF_LOAD_ADDRESS_UNKNOWN", `Cannot resolve the load address of ${section.name}`);
            categories.flash.estimated = true;
            // Do not assign a guessed LMA to a region with a confirmed capacity.
            const entry = {
                name: section.name,
                address: hex(section.addr),
                runtimeAddress: hex(section.addr),
                loadAddress: null,
                size: section.size,
                role: "load",
                region: null,
                loadAddressKnown: false
            };
            categories.flash.sections.push(entry);
            categories.flash.ranges.push([section.addr, section.addr + section.size]);
        } else record(section, lma, "load");
    }
    for (const category of Object.values(categories)) {
        category.total = unionBytes(category.ranges);
        category.sections = [
            ...new Map(category.sections.map((s) => [`${s.name}:${s.address}:${s.size}`, s])).values()
        ];
        delete category.ranges;
    }
    const report = regions.map(({ ranges, complete, ...region }) => {
        const used = complete ? Math.max(region.origin, ...ranges.map((r) => r[1])) - region.origin : null;
        return {
            ...region,
            complete,
            used,
            sectionBytes: complete ? unionBytes(ranges) : null,
            percent: complete ? (used / region.capacity) * 100 : null
        };
    });
    if (!regions.length) warn("MEMORY_LAYOUT_MISSING", "Select a matching .map or linker script for region capacities");
    return {
        elf: snapshot.elf,
        flash: categories.flash,
        ram: categories.ram,
        regions: report,
        usageBasis: { regions: "high-water-span", totals: "section-range-union", includesLinkerReservations: true },
        diagnostics,
        warnings: [...(snapshot.warnings || []), ...diagnostics.map((d) => `${d.code}: ${d.message}`)]
    };
}

module.exports = { analyzeMemory, topSymbols, loadAddress, unionBytes };
