"use strict";
// 显示名（C++ 限定名）在故障定位、ELF 排行与变量解析中的呈现，同时保留原始 mangled 名。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FaultService } = require("../src/services/faultService");
const { resolveVariableRequests } = require("../src/elfSymbols");
const { loadProvider } = require("./helpers/load-provider");

// 最小合法 ELF32（仅空头 + 一个空节头），供 _analyzeElf 的 parseElfSections 读取。
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

// —— faultService：pcSymbol 用显示名，pcSymbolRaw 保留原始名 ——
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
    assert.strictEqual(r.pcSymbol, "ns::func+0x4", "PC 用可读显示名");
    assert.strictEqual(r.pcSymbolRaw, "_ZN2ns4funcEv+0x4", "PC 同时保留原始 mangled 名");
    assert.strictEqual(r.lrSymbol, "", "无匹配时显示名为空");
    assert.strictEqual(r.lrSymbolRaw, "");

    // —— resolveVariableRequests：displayName 唯一别名解析，身份仍返回原始名 ——
    const symbols = [
        { name: "_ZN2ns5nsVarE", displayName: "ns::nsVar", address: 0x20000020, size: 4, watchType: "i32" }
    ];
    const [req] = resolveVariableRequests(symbols, [{ name: "ns::nsVar" }]);
    assert.strictEqual(req.name, "_ZN2ns5nsVarE", "解析身份始终为原始规范名");
    assert.strictEqual(req.address >>> 0, 0x20000020);

    // 多个符号共享同一 displayName（重载）→ 不作别名，回落到未找到
    const overloaded = [
        { name: "_ZN2ns1fv", displayName: "ns::f", address: 0x20000100, size: 4, watchType: "i32" },
        { name: "_ZN2ns1fw", displayName: "ns::f", address: 0x20000104, size: 4, watchType: "i32" }
    ];
    assert.throws(() => resolveVariableRequests(overloaded, [{ name: "ns::f" }]), { code: "VARIABLE_NOT_FOUND" });

    // —— _analyzeElf：topSymbols 含 displayName 且保留 name ——
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
        assert.strictEqual(fn.name, "_ZN2ns4funcEv", "保留原始名");
        assert.strictEqual(fn.displayName, "ns::func", "附带显示名");
        assert.strictEqual(obj.name, "_ZN2ns5nsVarE");
        assert.strictEqual(obj.displayName, "ns::nsVar");

        const updates = [];
        provider._webviewView = { webview: { postMessage: (message) => updates.push(message) } };
        provider._livePanels = new Map();
        provider._onElfChange("types", { elf: { sha256: "x" } }, [
            { name: "_ZN2ns5nsVarE", displayName: "ns::nsVar", watchType: "i32", isComposite: false }
        ]);
        assert.strictEqual(updates[0].symbols[0].displayName, "ns::nsVar", "渐进加载向侧边栏发送 C++ 显示名");
    } finally {
        fs.rmSync(tmp, { force: true });
    }

    console.log("C++ display name tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
