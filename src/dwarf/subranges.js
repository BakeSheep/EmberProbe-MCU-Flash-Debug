"use strict";

const { DW_TAG_subrange_type } = require("./constants");

// GCC encodes a zero-length array's upper bound as -1 of the 32-bit sizetype.
// data1/data2 all-ones are ordinary bounds (uint8_t a[256] is data1 0xff).
function isEmptyUpperBound(value, form) {
    const maximum = { 0x06: 4294967295, 0x07: "18446744073709551615" }[form];
    return (
        value === -1 || value?.integer64 === "-1" || (maximum !== undefined && (value?.integer64 ?? value) === maximum)
    );
}

function arrayDimensions(typeRef, dies, childrenMap) {
    const dimensions = [];
    for (const off of childrenMap.get(typeRef) || []) {
        const die = dies.get(off);
        if (die?.tag !== DW_TAG_subrange_type) continue;
        const count = die.subrangeCount ?? (die.subrangeUpperBound === undefined ? 0 : die.subrangeUpperBound + 1);
        if (!Number.isSafeInteger(count) || count < 0)
            throw Object.assign(new Error("DWARF array dimension exceeds its integer budget"), {
                code: "DWARF_BUDGET_EXCEEDED"
            });
        dimensions.push(count);
    }
    return dimensions;
}

module.exports = { arrayDimensions, isEmptyUpperBound };
