"use strict";

// Validate the complete layout before any consumer allocates expanded leaves or trees.
function validateComposite(layout, size, address = 0) {
    let remaining = 65536;
    const invalid = () => {
        throw Object.assign(new Error("Composite layout exceeds its size or expansion budget"), {
            code: "INVALID_COMPOSITE_LAYOUT"
        });
    };
    if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(address) ||
        address < 0 ||
        address + size > 0x100000000
    )
        invalid();
    const walk = (node, available, depth, multiplier) => {
        if (!node || depth > 16 || (remaining -= multiplier) < 0) invalid();
        if (node.kind === "array") {
            const count = node.totalElements;
            const width = node.elementType?.byteSize;
            if (
                !Number.isSafeInteger(count) ||
                count < 0 ||
                !Number.isSafeInteger(width) ||
                width <= 0 ||
                !Number.isSafeInteger(count * width) ||
                count * width > available ||
                count * multiplier > remaining
            )
                invalid();
            if (node.elementType.compositeLayout)
                walk(node.elementType.compositeLayout, width, depth + 1, multiplier * count);
            else remaining -= count * multiplier;
        } else {
            for (const member of node.members || []) {
                const offset = member.offset;
                const width = member.byteSize;
                if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    !Number.isSafeInteger(width) ||
                    width < 0 ||
                    offset + width > available
                )
                    invalid();
                if (member.compositeLayout) walk(member.compositeLayout, width, depth + 1, multiplier);
                else if ((remaining -= multiplier) < 0) invalid();
            }
        }
    };
    walk(layout, size, 0, 1);
}

module.exports = { validateComposite };
