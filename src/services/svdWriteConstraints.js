"use strict";

function invalid(message) {
    return Object.assign(new Error(message), { code: "INVALID_SVD_WRITE_CONSTRAINT" });
}
function parseWriteConstraint(node, integer) {
    if (node === undefined) return undefined;
    if (!node || typeof node !== "object" || Array.isArray(node)) throw invalid("Invalid writeConstraint");
    const keys = Object.keys(node);
    if (keys.length !== 1 || !["range", "writeAsRead", "useEnumeratedValues"].includes(keys[0]))
        throw invalid("writeConstraint must specify exactly one supported constraint");
    const kind = keys[0];
    if (kind !== "range") {
        const value = String(node[kind]);
        if (!["true", "false", "1", "0"].includes(value)) throw invalid("Invalid writeConstraint boolean");
        return { kind, enabled: value === "true" || value === "1" };
    }
    const minimum = integer(node.range?.minimum, "writeConstraint minimum", { bigint: true });
    const maximum = integer(node.range?.maximum, "writeConstraint maximum", { bigint: true });
    if (minimum > maximum) throw invalid("Invalid writeConstraint range");
    return { kind, minimum, maximum };
}

function readableEnumeration(entry) {
    return entry.usage !== "write";
}
function writableEnumeration(entry) {
    return entry.usage !== "read";
}
function enumMatches(entry, value) {
    return entry.mask === null ? entry.value === value : (value & entry.mask) === entry.value;
}
function assertConstraint(constraint, value, previous, enumerations, target) {
    if (!constraint) return;
    let valid = true;
    if (constraint.kind === "range") valid = value >= constraint.minimum && value <= constraint.maximum;
    else if (constraint.enabled && constraint.kind === "writeAsRead") valid = value === previous;
    else if (constraint.enabled && constraint.kind === "useEnumeratedValues")
        valid = enumerations.some((entry) => writableEnumeration(entry) && enumMatches(entry, value));
    if (!valid)
        throw Object.assign(new Error(`Peripheral write violates ${constraint.kind}: ${target}`), {
            code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION",
            details: { target, constraint: constraint.kind, value: value.toString(), previous: previous.toString() }
        });
}

function assertRegisterConstraints(register, value, previous) {
    // Register constraints default to fields; explicit field constraints replace
    // that default. Registers without fields use the whole scalar value.
    if (!register.fields.length) assertConstraint(register.writeConstraint, value, previous, [], register.path);
    for (const field of register.fields) {
        const mask = (1n << BigInt(field.bitWidth)) - 1n;
        const shift = BigInt(field.bitOffset);
        assertConstraint(
            field.writeConstraint,
            (value >> shift) & mask,
            (previous >> shift) & mask,
            field.enumerations,
            field.path
        );
    }
}

module.exports = {
    parseWriteConstraint,
    assertRegisterConstraints,
    readableEnumeration,
    writableEnumeration,
    enumMatches
};
