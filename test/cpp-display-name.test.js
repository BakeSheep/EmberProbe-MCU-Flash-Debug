"use strict";
// Display names (C++ qualified names) in fault location, ELF ranking and variable resolution, keeping the original
// mangled names.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FaultService } = require("../src/services/faultService");
const { resolveVariableRequests } = require("../src/elfSymbols");
const { loadProvider } = require("./helpers/load-provider");

// Minimal valid ELF32 (an empty header and one empty section header) for _analyzeElf's parseElfSections.
function minimalElf() {
    const buf = Buffer.alloc(52 + 40);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1;
    buf[5] = 1;
    buf[6] = 1;
    buf.writeUInt16LE(2, 16);
    buf.writeUInt16LE(0x28, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(52, 32); // e_shoff
    buf.writeUInt16LE(52, 40); // e_ehsize
    buf.writeUInt16LE(40, 46); // e_shentsize
    buf.writeUInt16LE(1, 48); // e_shnum
    buf.writeUInt16LE(0, 50); // e_shstrndx
    return buf;
}

// faultService: pcSymbol uses the display name and pcSymbolRaw keeps the original
(async () => {
    const fault = new FaultService(
        {
            readFaultInfo: async () => ({
                values: { cfsr: 1 },
                targetState: "halted",
                registers: {},
                pc: "0x08000104",
                lr: "0x08000200",
                sp: "0x20001000",
                xpsr: "0x01000000"
            }),
            decodeFaultRegisters: () => ({ faultDetected: true, faults: ["IACCVIOL"], exception: "HardFault" })
        },
        {
            nearestFunction: (_functions, address) =>
                address === 0x08000104 ? { name: "_ZN2ns4funcEv", displayName: "ns::func", offset: 4 } : null
        }
    );
    const r = await fault.read({}, () => [{ name: "_ZN2ns4funcEv" }]);
    assert.strictEqual(r.pcSymbol, "ns::func+0x4", "PC uses the readable display name");
    assert.strictEqual(r.pcSymbolRaw, "_ZN2ns4funcEv+0x4", "PC keeps the original mangled name");
    assert.strictEqual(r.lrSymbol, "", "no match leaves the display name empty");
    assert.strictEqual(r.lrSymbolRaw, "");

    // resolveVariableRequests: unique displayName aliases resolve while the identity stays the original name
    const symbols = [
        { name: "_ZN2ns5nsVarE", displayName: "ns::nsVar", address: 0x20000020, size: 4, watchType: "i32" }
    ];
    const [req] = resolveVariableRequests(symbols, [{ name: "ns::nsVar" }]);
    assert.strictEqual(req.name, "_ZN2ns5nsVarE", "the resolved identity is always the original name");
    assert.strictEqual(req.address >>> 0, 0x20000020);

    // Several symbols sharing one displayName (overloads) are not aliased; the request is rejected as ambiguous with
    // the candidate identities
    const overloaded = [
        { name: "_ZN2ns1fv", displayName: "ns::f", address: 0x20000100, size: 4, watchType: "i32" },
        { name: "_ZN2ns1fw", displayName: "ns::f", address: 0x20000104, size: 4, watchType: "i32" }
    ];
    assert.throws(
        () => resolveVariableRequests(overloaded, [{ name: "ns::f" }]),
        (error) =>
            error.code === "VARIABLE_AMBIGUOUS" &&
            error.details.candidates.map((candidate) => candidate.name).join() === "_ZN2ns1fv,_ZN2ns1fw"
    );

    // _analyzeElf: topSymbols carry displayName and keep name
    const tmp = path.join(fs.realpathSync(os.tmpdir()), `emberprobe-cpp-display-${process.pid}.elf`);
    fs.writeFileSync(tmp, minimalElf());
    try {
        const Provider = loadProvider({
            debug: {},
            workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) }
        });
        const provider = Object.create(Provider.prototype);
        provider._elfService = {
            load: async () => ({
                elf: { path: tmp, sha256: "x", size: 92, mtimeMs: 1 },
                memory: require("../src/elfSymbols").parseElfSections(minimalElf()),
                functions: [{ name: "_ZN2ns4funcEv", displayName: "ns::func", address: 0x08000100, size: 16 }],
                symbols: [{ name: "_ZN2ns5nsVarE", displayName: "ns::nsVar", address: 0x20000020, size: 4 }],
                warnings: []
            })
        };
        const result = await provider._analyzeElf({ top: 20 });
        const fn = result.topSymbols.find((s) => s.kind === "function");
        const obj = result.topSymbols.find((s) => s.kind === "object");
        assert.strictEqual(fn.name, "_ZN2ns4funcEv", "keeps the original name");
        assert.strictEqual(fn.displayName, "ns::func", "carries the display name");
        assert.strictEqual(obj.name, "_ZN2ns5nsVarE");
        assert.strictEqual(obj.displayName, "ns::nsVar");

        const updates = [];
        provider._webviewView = { webview: { postMessage: (message) => updates.push(message) } };
        provider._livePanels = new Map();
        provider._onElfChange("types", { elf: { sha256: "x" } }, [
            { name: "_ZN2ns5nsVarE", displayName: "ns::nsVar", watchType: "i32", isComposite: false }
        ]);
        assert.strictEqual(
            updates[0].symbols[0].displayName,
            "ns::nsVar",
            "progressive loading sends C++ display names to the sidebar"
        );

        provider._context = {
            workspaceState: { get: () => [{ name: "_ZN2ns5nsVarE.member" }] }
        };
        provider._elfService.layout = async () => {
            throw new Error("DWARF root layout cannot fit its expansion budget");
        };
        const selected = { symbols: [{ ...symbols[0], isComposite: true }], warnings: [] };
        await provider._hydrateSelectedLayouts(selected);
        assert.deepStrictEqual(selected.warnings, ["ns::nsVar: DWARF root layout cannot fit its expansion budget"]);
        provider.readElfSymbols = () => ({ symbols });
        assert.strictEqual(provider._variableDisplayName({ name: "_ZN2ns5nsVarE.member" }), "ns::nsVar.member");
        provider.readElfSymbols = () => {
            throw new Error("ELF unavailable");
        };
        assert.strictEqual(
            provider._variableDisplayName({ name: "_ZN2ns5nsVarE.member", displayName: "ns::nsVar.member" }),
            "ns::nsVar.member"
        );
    } finally {
        fs.rmSync(tmp, { force: true });
    }

    console.log("C++ display name tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
