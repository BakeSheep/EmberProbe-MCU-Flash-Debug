"use strict";

const c = require("./constants");
const MAX_COMPARISON_NODES = 16384;
const TYPE_TAGS = new Set([
    c.DW_TAG_structure_type,
    c.DW_TAG_class_type,
    c.DW_TAG_union_type,
    c.DW_TAG_enumeration_type
]);
const CHILD_TAGS = new Set([
    c.DW_TAG_member,
    c.DW_TAG_inheritance,
    c.DW_TAG_subrange_type,
    c.DW_TAG_enumerator,
    0x2f,
    0x30,
    0x4107
]);
const WRAPPERS = new Set([c.DW_TAG_typedef, c.DW_TAG_const_type, c.DW_TAG_volatile_type, c.DW_TAG_restrict_type]);

function typeFamily(tag) {
    return tag === c.DW_TAG_class_type ? c.DW_TAG_structure_type : tag;
}

function typeDie(ref, dies) {
    for (let depth = 0; depth < 32; depth++) {
        const die = dies.get(ref);
        if (!WRAPPERS.has(die?.tag)) return die;
        ref = die.typeRef;
    }
    return null;
}

function isTypeDeclaration(ref, dies) {
    return !!typeDie(ref, dies)?.isDecl;
}

function declarationMatchesDefinition(left, right, dies) {
    const a = typeDie(left, dies),
        b = typeDie(right, dies);
    const name = a?.qualifiedTypeName || a?.name;
    return !!(
        a &&
        b &&
        TYPE_TAGS.has(a.tag) &&
        typeFamily(a.tag) === typeFamily(b.tag) &&
        !!a.isDecl !== !!b.isDecl &&
        (a.isDecl ? b.byteSize : a.byteSize) > 0 &&
        name &&
        name === (b.qualifiedTypeName || b.name) &&
        (!(a.cuLocalType || b.cuLocalType) || (a.unit === b.unit && a.localTypeScope === b.localTypeScope))
    );
}

// Compare storage identity without expanding arrays or confusing equal short names
// with equal layouts. A cycle is accepted only after both nodes' metadata matches.
function equivalentTypes(left, right, parsed, budget = { nodes: 0 }) {
    const pending = [[left, right, 0]];
    const seen = new Map();
    while (pending.length) {
        const [aRef, bRef, depth] = pending.pop();
        if (aRef === bRef) continue;
        if (++budget.nodes > MAX_COMPARISON_NODES || depth > 64) return false;
        const a = parsed.dies.get(aRef),
            b = parsed.dies.get(bRef);
        if (!a || !b || typeFamily(a.tag) !== typeFamily(b.tag)) return false;
        const metadata = (die) => [
            die.qualifiedTypeName || die.name || "",
            die.byteSize,
            die.encoding,
            !!die.isDecl,
            !!die.enumClass,
            die.constantValue,
            die.subrangeCount,
            die.subrangeUpperBound,
            die.memberOffset,
            !!die.memberLocationUnsupported,
            die.memberOffset === undefined ? die.memberExpression : undefined,
            die.bitSize,
            die.bitOffset,
            die.dataBitOffset,
            die.virtuality || 0
        ];
        const aMetadata = JSON.stringify(metadata(a)),
            bMetadata = JSON.stringify(metadata(b));
        if (aMetadata.length > 65536 || bMetadata.length > 65536 || aMetadata !== bMetadata) return false;
        if (seen.get(aRef)?.has(bRef)) continue;
        if (!seen.has(aRef)) seen.set(aRef, new Set());
        seen.get(aRef).add(bRef);
        const aChildren = parsed.childrenMap.get(aRef) || [],
            bChildren = parsed.childrenMap.get(bRef) || [];
        budget.nodes += aChildren.length + bChildren.length;
        if (budget.nodes > MAX_COMPARISON_NODES) return false;
        const children = (offsets) => offsets.filter((off) => CHILD_TAGS.has(parsed.dies.get(off)?.tag));
        const aFields = children(aChildren),
            bFields = children(bChildren);
        if (aFields.length !== bFields.length) return false;
        for (let index = 0; index < aFields.length; index++) pending.push([aFields[index], bFields[index], depth + 1]);
        if (a.typeRef !== undefined || b.typeRef !== undefined) pending.push([a.typeRef, b.typeRef, depth + 1]);
    }
    return true;
}

// Each comparison gets its own node budget so one large type cannot starve
// unrelated comparisons; a total cap still bounds the whole ELF's work.
const MAX_TOTAL_COMPARISON_NODES = 1 << 20;
function createTypeComparer(parsed) {
    let total = 0;
    return (left, right) => {
        if (total >= MAX_TOTAL_COMPARISON_NODES) return false;
        const budget = { nodes: 0 };
        const result = equivalentTypes(left, right, parsed, budget);
        total += budget.nodes;
        return result;
    };
}

function normalizeTypeDeclarations(parsed) {
    const { dies, parentOf } = parsed;
    const definitions = new Map(),
        specifications = new Map();
    const keyOf = (die) => typeFamily(die.tag) + ":" + die.qualifiedTypeName;
    const localScope = (ref) => {
        const seen = new Set();
        const scopes = [];
        const pending = [ref];
        while (pending.length) {
            let current = pending.pop();
            while (current !== undefined) {
                if (seen.has(current)) break;
                if (seen.size >= 64) return "unknown:" + ref;
                seen.add(current);
                const die = dies.get(current);
                if (!die) return "unknown:" + ref;
                if ((die.tag === c.DW_TAG_namespace && !die.name) || [c.DW_TAG_subprogram, 0x0b].includes(die.tag))
                    scopes.push(current);
                if (die.specificationRef !== undefined) pending.push(die.specificationRef);
                current = parentOf.get(current);
            }
        }
        return scopes.sort((a, b) => a - b).join(",");
    };
    for (const [ref, die] of dies) {
        if (!TYPE_TAGS.has(die.tag)) continue;
        die.localTypeScope = localScope(ref);
        die.cuLocalType = !!die.localTypeScope;
        if (die.isDecl || !die.qualifiedTypeName || !Number.isSafeInteger(die.byteSize) || die.byteSize <= 0) continue;
        const key = keyOf(die);
        if (!definitions.has(key)) definitions.set(key, { shared: [], units: new Map() });
        const group = definitions.get(key);
        if (!group.units.has(die.unit)) group.units.set(die.unit, new Map());
        const scopes = group.units.get(die.unit);
        if (!scopes.has(die.localTypeScope)) scopes.set(die.localTypeScope, []);
        scopes.get(die.localTypeScope).push(ref);
        if (!die.cuLocalType) group.shared.push(ref);
        const declaration = dies.get(die.specificationRef);
        if (
            declaration?.isDecl &&
            typeFamily(declaration.tag) === typeFamily(die.tag) &&
            (!(localScope(die.specificationRef) || die.cuLocalType) || declaration.unit === die.unit)
        ) {
            if (!specifications.has(die.specificationRef)) specifications.set(die.specificationRef, []);
            specifications.get(die.specificationRef).push(ref);
        }
    }
    const redirects = new Map(),
        choices = new Map();
    // Bound work across all groups as well as within each comparison. When the
    // comparison budget is exhausted, declarations retain the read-only fallback.
    const equivalent = createTypeComparer(parsed);
    const choose = (refs) => {
        if (!refs?.length || refs.length > 64) return undefined;
        if (!choices.has(refs)) {
            const first = refs[0];
            choices.set(refs, refs.every((ref) => ref === first || equivalent(first, ref)) ? first : undefined);
        }
        return choices.get(refs);
    };
    for (const [ref, die] of dies) {
        if (!TYPE_TAGS.has(die.tag) || !die.isDecl || !die.qualifiedTypeName) continue;
        const group = definitions.get(keyOf(die));
        const refs =
            specifications.get(ref) ||
            group?.units.get(die.unit)?.get(die.localTypeScope) ||
            (!die.cuLocalType ? group?.shared : null);
        const definition = choose(refs);
        if (definition !== undefined) redirects.set(ref, definition);
    }
    for (const die of dies.values()) if (redirects.has(die.typeRef)) die.typeRef = redirects.get(die.typeRef);
}

module.exports = {
    equivalentTypes,
    createTypeComparer,
    declarationMatchesDefinition,
    isTypeDeclaration,
    normalizeTypeDeclarations
};
