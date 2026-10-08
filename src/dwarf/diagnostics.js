"use strict";
const MAX_DIAGNOSTICS = 1024;
function appendDiagnostic(diagnostics, diagnostic) {
    if (diagnostics.length >= MAX_DIAGNOSTICS)
        throw Object.assign(new Error("DWARF diagnostic budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
    diagnostics.push(diagnostic);
}
module.exports = { appendDiagnostic, MAX_DIAGNOSTICS };
