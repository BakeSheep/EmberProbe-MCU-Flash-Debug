"use strict";
const elfSymbols = require("../elfSymbols");
const { runtimeWatchEntry } = require("./runtimeWatch");
const { requiresRuntimePath } = require("../webview/runtime");

// One Agent write batch is shown for confirmation and, off word boundaries, runs while halted.
const MAX_WRITE_VARIABLES = 64;

// One failed variable of a batch agent read keeps its error code, message and details so the skill can map it to a
// structured diagnostic.
function variableErrorEntry({ requestedName, error }) {
    return {
        requestedName,
        error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {})
        }
    };
}

// Plans an Agent read of params.variables against the symbols readElf() returns: scalars, expanded static members,
// composites and runtime objects. Failures with an error code are reported per variable in variableErrors; only when
// nothing is readable does the first one throw.
function readPlan(params, readElf, layoutErrors = null) {
    const raw = Array.isArray(params.variables) ? params.variables : [];
    const requests = raw.map((item) =>
        typeof item === "string"
            ? { name: item }
            : {
                  name: item?.name,
                  type: item?.type
              }
    );
    if (!requests.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
    const elfResult = readElf();
    const resolveSymbol = elfSymbols.createSymbolResolver(elfResult.symbols);
    const scalarRequests = [];
    const expandedScalars = [];
    const compositePlan = [];
    const failures = [];
    const planRequest = (req, index) => {
        const parsed = elfSymbols.parseMemberPath(req.name);
        const baseName = parsed ? parsed.base : req.name;
        const symbol = resolveSymbol(baseName, req.name);
        // When layout prefetch failed (budget, parse error, ...) report that error instead of a generic
        // COMPOSITE_LAYOUT_MISSING
        const layoutError = !symbol.compositeLayout && layoutErrors?.get(symbol.name);
        if (layoutError) throw layoutError;
        const expanded = elfSymbols.expandedStaticLeaves(symbol, parsed);
        if (
            expanded.length === 1 &&
            elfSymbols.resolveLayoutPath(symbol, symbol.compositeLayout, parsed)?.node.watchType
        ) {
            expandedScalars.push({ ...expanded[0], name: expanded[0].path, requestedName: req.name });
            return;
        }
        const runtime = !expanded.length && runtimeWatchEntry(req.name, symbol, parsed?.segments || []);
        if (runtime) {
            compositePlan.push({ ...runtime, requestedName: req.name });
            return;
        }
        if (!expanded.length && requiresRuntimePath(symbol, parsed?.segments || []))
            throw Object.assign(new Error(`Invalid runtime member path: ${req.name}`), {
                code: "INVALID_VARIABLE_PATH"
            });
        if (symbol.isComposite) {
            if (!symbol.compositeLayout) {
                // Without a layout the full path must not reach the scalar resolver, which would report a
                // misleading VARIABLE_NOT_FOUND
                throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), {
                    code: "COMPOSITE_LAYOUT_MISSING",
                    details: { base: symbol.name, reason: symbol.unsupportedReason }
                });
            }
            if (
                parsed &&
                parsed.segments.length &&
                !elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed).length
            ) {
                throw Object.assign(new Error(`Invalid composite member path: ${req.name}`), {
                    code: "INVALID_VARIABLE_PATH"
                });
            }
            const totalSize = Number(symbol.size) || 0;
            compositePlan.push({
                requestedName: req.name,
                name: symbol.name,
                address: Number(symbol.address) >>> 0,
                size: totalSize,
                type: "",
                isComposite: true,
                compositeLayout: symbol.compositeLayout,
                layoutExpansions: symbol.layoutExpansions,
                layoutExpansionGeneration: symbol.layoutExpansionGeneration,
                pathSpec: parsed
            });
        } else if (parsed && parsed.segments.length) {
            throw Object.assign(new Error(`${req.name} is not a composite variable; member paths are not applicable`), {
                code: "INVALID_VARIABLE_PATH"
            });
        } else {
            // Scalars are re-resolved by their resolved identity, so qualified names ('main.c'::x, path suffixes)
            // need not match the identity literally.
            scalarRequests.push({ req: { ...req, name: symbol.name }, requestedName: req.name, index });
        }
    };
    // Only expected failures with an error code are isolated per item; exceptions without one are bugs and still
    // throw for the whole call
    const isolate = (index, fn) => {
        try {
            fn();
        } catch (error) {
            if (!error?.code) throw error;
            failures.push({ index, requestedName: requests[index].name, error });
        }
    };
    requests.forEach((req, index) => isolate(index, () => planRequest(req, index)));
    let scalarPlan = [];
    try {
        scalarPlan = scalarRequests.length
            ? elfSymbols
                  .resolveVariableRequests(
                      elfResult.symbols,
                      scalarRequests.map((entry) => entry.req)
                  )
                  .map((item, position) => ({ ...item, requestedName: scalarRequests[position].requestedName }))
            : [];
    } catch {
        // Batch resolution stops at the first error; re-resolve item by item to isolate failures while keeping the
        // duplicate request check between items.
        scalarPlan = [];
        const seen = new Set();
        for (const { req, requestedName, index } of scalarRequests) {
            isolate(index, () => {
                const [resolvedItem] = elfSymbols.resolveVariableRequests(elfResult.symbols, [req]);
                const item = { ...resolvedItem, requestedName };
                if (seen.has(item.name))
                    throw Object.assign(new Error(`Variable requested more than once: ${item.name}`), {
                        code: "DUPLICATE_VARIABLE"
                    });
                seen.add(item.name);
                scalarPlan.push(item);
            });
        }
    }
    const plan = expandedScalars.concat(scalarPlan);
    failures.sort((a, b) => a.index - b.index);
    if (failures.length && !plan.length && !compositePlan.length) {
        const first = failures[0].error;
        if (failures.length > 1)
            first.details = { ...(first.details || {}), variableErrors: failures.map(variableErrorEntry) };
        throw first;
    }
    return { elfResult, plan, compositePlan, variableErrors: failures.map(variableErrorEntry) };
}

// Decodes one sample of a read plan into the values the Agent receives, keyed by requested name.
function decodeSample(plan, samples, compositePlan) {
    const byName = new Map(samples.map((sample) => [sample.name, sample]));
    const timestamp = samples.reduce((latest, sample) => Math.max(latest, sample.t || 0), 0) || Date.now();
    const values = {};
    for (const item of plan) {
        const sample = byName.get(item.name);
        const decoded =
            Number.isInteger(item.bitSize) && sample?.bytes
                ? elfSymbols.decodeBitfieldValue(sample.bytes, item.type, item.bitOffset, item.bitSize)
                : {
                      value: sample?.bytes ? elfSymbols.decodeValue(sample.bytes, item.type) : null,
                      valueText: sample?.bytes ? elfSymbols.decodeValueText(sample.bytes, item.type) : null
                  };
        values[item.name] = {
            requestedName: item.requestedName,
            ...decoded,
            type: item.type,
            address: `0x${item.address.toString(16).toUpperCase()}`
        };
    }
    if (compositePlan) {
        for (const comp of compositePlan) {
            const sample = byName.get(comp.name);
            const fullTree = comp.runtimeLayout
                ? sample?.runtimeTree
                : sample?.bytes
                  ? elfSymbols.decodeComposite(sample.bytes, comp.compositeLayout, comp)
                  : null;
            const node = comp.runtimeLayout
                ? fullTree
                : fullTree
                  ? elfSymbols.navigateCompositeTree(fullTree, comp.pathSpec)
                  : null;
            const baseAddr = comp.address >>> 0;
            const addrHex = (off) => `0x${((baseAddr + (off || 0)) >>> 0).toString(16).toUpperCase()}`;
            if (elfSymbols.isScalarLeafNode(node)) {
                // A path that reaches a single scalar member or element is returned as a scalar for trend analysis
                // and readability
                values[comp.requestedName] = {
                    requestedName: comp.requestedName,
                    value: node.value,
                    valueText: node.valueText ?? null,
                    type: node.type,
                    address: comp.runtimeLayout ? addrHex(node.address - baseAddr) : addrHex(node.offset)
                };
            } else {
                values[comp.requestedName] = {
                    requestedName: comp.requestedName,
                    tree: node,
                    type: "composite",
                    address: addrHex(node && node.offset),
                    ...(sample?.diagnostic ? { diagnostic: sample.diagnostic } : {})
                };
            }
        }
    }
    return { timestamp, values };
}

// Plans a write of exactly named scalar variables or members: encodes each value and refuses targets that are const,
// pointers, overlapping or outside writable RAM. Shared by Agent and sidebar writes.
function writePlan(values, readElf) {
    const requests = (Array.isArray(values) ? values : []).map((item) => ({
        name: String(item?.name || "").trim(),
        value: item?.value
    }));
    if (!requests.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
    if (requests.length > MAX_WRITE_VARIABLES)
        throw Object.assign(new Error(`At most ${MAX_WRITE_VARIABLES} variables can be written at once`), {
            code: "INVALID_PARAMS"
        });
    const elfResult = readElf();
    // A write target must be named exactly; a case-folded match could be a different variable.
    const resolveSymbol = elfSymbols.createSymbolResolver(elfResult.symbols, { foldCase: false });
    const SHF_WRITE = 1,
        SHF_ALLOC = 2;
    let writable = [];
    try {
        // ElfService.read() identity-checks the result, including these cached sections.
        const parsed = elfResult.memory;
        writable = parsed.sections.filter(
            (s) => (s.flags & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) && s.size > 0
        );
    } catch (e) {
        writable = [];
    }
    const inWritable = (address, size) => writable.some((s) => address >= s.addr && address + size <= s.addr + s.size);
    const items = [];
    const seen = new Set();
    const ranges = [];
    for (const req of requests) {
        if (!req.name) throw Object.assign(new Error("Variable name is required"), { code: "INVALID_VARIABLE_NAME" });
        const parsed = elfSymbols.parseMemberPath(req.name);
        const baseName = parsed ? parsed.base : req.name;
        // Write targets must be unique: a bare name defined in several compilation units throws VARIABLE_AMBIGUOUS
        // instead of writing the first match.
        const symbol = resolveSymbol(baseName, req.name);
        let target;
        if (symbol && symbol.isComposite) {
            // A pointer/STL anywhere in the type graph adds a runtime layout; plain
            // fixed-offset user members of such objects stay writable.
            if (
                (symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout) &&
                !elfSymbols.staticRuntimeWriteLeaf(symbol, symbol.compositeLayout, parsed)
            )
                throw Object.assign(
                    new Error(`Writing C++ runtime container or dynamic member is not supported: ${req.name}`),
                    {
                        code: "WRITE_NOT_ALLOWED"
                    }
                );
            if (!symbol.compositeLayout)
                throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), {
                    code: "UNSUPPORTED_VARIABLE"
                });
            if (!parsed || !parsed.segments.length)
                throw Object.assign(new Error(`Writing a whole composite variable is not supported: ${req.name}`), {
                    code: "UNSUPPORTED_VARIABLE"
                });
            const leaves = elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed);
            if (leaves.length !== 1)
                throw Object.assign(new Error(`Write target must resolve to exactly one scalar member: ${req.name}`), {
                    code: leaves.length ? "UNSUPPORTED_VARIABLE" : "INVALID_VARIABLE_PATH"
                });
            if (Number.isInteger(leaves[0].bitSize))
                throw Object.assign(new Error(`Bitfield writes are not supported: ${req.name}`), {
                    code: "UNSUPPORTED_VARIABLE"
                });
            target = {
                name: leaves[0].path,
                address: leaves[0].address >>> 0,
                type: leaves[0].type,
                size: leaves[0].size,
                isBoolean: !!leaves[0].isBoolean,
                isConst: !!leaves[0].isConst,
                isReference: !!leaves[0].isReference,
                isMemberPointer: !!leaves[0].isMemberPointer,
                isPointer: !!leaves[0].isPointer
            };
            if (leaves[0].enumEncodingInferred)
                throw Object.assign(new Error(`Enum write encoding is unavailable: ${req.name}`), {
                    code: "WRITE_TYPE_UNKNOWN"
                });
        } else {
            if (parsed?.segments.length)
                throw Object.assign(
                    new Error(`${req.name} is not a composite variable; member paths are not applicable`),
                    { code: "INVALID_VARIABLE_PATH" }
                );
            const [plan] = elfSymbols.resolveVariableRequests(elfResult.symbols, [{ name: symbol.name }]);
            const resolvedSymbol = symbol;
            if (resolvedSymbol?.isConst || resolvedSymbol?.isReference || resolvedSymbol?.isMemberPointer)
                throw Object.assign(new Error(`Writing to const / read-only storage is not allowed: ${req.name}`), {
                    code: "WRITE_NOT_ALLOWED"
                });
            if (resolvedSymbol?.isPointer)
                throw Object.assign(new Error(`Writing pointer storage is not supported: ${req.name}`), {
                    code: "WRITE_NOT_ALLOWED"
                });
            if (!resolvedSymbol?.hasDwarfWriteType) {
                throw Object.assign(
                    new Error(
                        `Variable type is not available from DWARF; refusing to guess a write encoding: ${req.name}`
                    ),
                    {
                        code: "WRITE_TYPE_UNKNOWN",
                        details: { name: plan.name, guessedType: plan.type }
                    }
                );
            }
            target = {
                name: plan.name,
                address: plan.address,
                type: plan.type,
                size: plan.size,
                isBoolean: !!resolvedSymbol.isBoolean,
                isConst: !!resolvedSymbol.isConst
            };
        }
        // Pointer storage is read-only for top-level variables and members alike.
        if (target.isReference || target.isMemberPointer || target.isPointer)
            throw Object.assign(
                new Error(`Writing pointer, C++ reference or member pointer storage is not supported: ${req.name}`),
                {
                    code: "WRITE_NOT_ALLOWED"
                }
            );
        if (target.isConst) {
            throw Object.assign(new Error(`Writing to const / read-only variable is not allowed: ${req.name}`), {
                code: "WRITE_NOT_ALLOWED",
                details: { name: target.name }
            });
        }
        if (seen.has(target.name))
            throw Object.assign(new Error(`Variable requested more than once: ${target.name}`), {
                code: "DUPLICATE_VARIABLE"
            });
        seen.add(target.name);
        if (target.isBoolean && ![0, 1, "0", "1", false, true].includes(req.value))
            throw Object.assign(new Error(`Boolean variables accept only 0 or 1: ${req.name}`), {
                code: "INVALID_WRITE_VALUE"
            });
        const bytes = elfSymbols.encodeValue(
            target.isBoolean && typeof req.value === "boolean" ? Number(req.value) : req.value,
            target.type
        );
        const end = target.address + Math.max(target.size, bytes.length);
        const overlap = ranges.find((range) => target.address < range.end && range.start < end);
        if (overlap)
            throw Object.assign(new Error(`Write targets overlap in memory: ${overlap.name} and ${target.name}`), {
                code: "DUPLICATE_VARIABLE",
                details: { names: [overlap.name, target.name] }
            });
        ranges.push({ start: target.address, end, name: target.name });
        if (!inWritable(target.address, Math.max(target.size, bytes.length))) {
            throw Object.assign(
                new Error(`Target address is outside writable RAM sections (.data/.bss): ${req.name}`),
                {
                    code: "WRITE_NOT_ALLOWED",
                    details: { name: target.name, address: `0x${target.address.toString(16).toUpperCase()}` }
                }
            );
        }
        items.push({
            requestedName: req.name,
            name: target.name,
            address: target.address,
            type: target.type,
            size: target.size,
            bytes,
            value: elfSymbols.decodeValue(bytes, target.type),
            valueText: elfSymbols.decodeValueText(bytes, target.type)
        });
    }
    return { elfResult, items };
}

module.exports = { readPlan, decodeSample, writePlan };
