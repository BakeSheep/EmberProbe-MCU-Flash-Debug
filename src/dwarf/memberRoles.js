"use strict";

// Display roles for C++ members. Roles only change what a view shows by default;
// raw paths, addresses and write rules are unchanged.
const STD_TYPE = /^(?:(?:struct|class|union)\s+)?(?:std|__gnu_cxx|__cxxabiv1)::/;
const RESERVED = /^(?:_[A-Z_]|__)/;

// Library types whose meaningful value lives in one internal member. A view shows that
// member (found by name through bases and internal members) in place of the object.
/** @type {Array<{pattern: RegExp, kind: string, targets: string[], presence?: string[]}>} */
const SUMMARIES = [
    {
        pattern: /^std::(?:atomic|__atomic_base|__atomic_float|__atomic_ref)</,
        kind: "value",
        targets: ["_M_i", "_M_fp", "_M_p"]
    },
    { pattern: /^std::array</, kind: "value", targets: ["_M_elems"] },
    { pattern: /^std::chrono::duration</, kind: "value", targets: ["__r"] },
    { pattern: /^std::chrono::time_point</, kind: "value", targets: ["__d"] },
    { pattern: /^std::(?:unique_ptr|shared_ptr|weak_ptr)</, kind: "value", targets: ["_M_head_impl", "_M_ptr"] },
    { pattern: /^std::function</, kind: "function", targets: ["_M_invoker"], presence: ["_M_manager"] }
];

function bareTypeName(typeName) {
    return String(typeName || "").replace(/^(?:struct|class|union)\s+/, "");
}

function isStdType(typeName) {
    return STD_TYPE.test(String(typeName || ""));
}

/**
 * @param {string} parentTypeName qualified name of the containing type
 * @param {{name?: string, isBase?: boolean, isArtificial?: boolean}} member
 * @returns {"artificial" | "internal" | undefined}
 */
function memberRole(parentTypeName, member) {
    const name = String(member?.name || "");
    if (member?.isArtificial || /^_vptr[.$]/.test(name)) return "artificial";
    if (isStdType(parentTypeName) && (member?.isBase || RESERVED.test(name))) return "internal";
    return undefined;
}

/** @returns {{kind: string, targets: string[], presence?: string[]} | undefined} */
function stdSummary(typeName) {
    const bare = bareTypeName(typeName);
    if (!isStdType(bare)) return undefined;
    const match = SUMMARIES.find((entry) => entry.pattern.test(bare));
    return match
        ? {
              kind: match.kind,
              targets: [...match.targets],
              ...(match.presence ? { presence: [...match.presence] } : {})
          }
        : undefined;
}

module.exports = { memberRole, stdSummary, isStdType };
