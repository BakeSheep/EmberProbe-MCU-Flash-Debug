"use strict";

class FaultService {
    constructor(faultInfo, elfSymbols) {
        this.faultInfo = faultInfo;
        this.elfSymbols = elfSymbols;
    }

    async read(options, functionsProvider) {
        const raw = await this.faultInfo.readFaultInfo(options);
        const decoded = this.faultInfo.decodeFaultRegisters(raw.values);
        let pcSymbol = "";
        let lrSymbol = "";
        let pcSymbolRaw = "";
        let lrSymbolRaw = "";
        let symbolication = "ok";
        try {
            const functions = functionsProvider() || [];
            // symbolize 同时产出可读显示名与原始（mangled）名，供核对。
            const symbolize = (hex) => {
                const fn = this.elfSymbols.nearestFunction(functions, parseInt(hex, 16));
                if (!fn) return { display: "", raw: "" };
                const off = `+0x${fn.offset.toString(16).toUpperCase()}`;
                return { display: `${fn.displayName || fn.name}${off}`, raw: `${fn.name}${off}` };
            };
            if (raw.pc) {
                const s = symbolize(raw.pc);
                pcSymbol = s.display;
                pcSymbolRaw = s.raw;
            }
            if (raw.lr) {
                const s = symbolize(raw.lr);
                lrSymbol = s.display;
                lrSymbolRaw = s.raw;
            }
        } catch {
            symbolication = "unavailable";
        }
        return {
            targetState: raw.targetState,
            registers: raw.registers,
            faultDetected: decoded.faultDetected,
            faults: decoded.faults,
            exception: decoded.exception,
            pc: raw.pc,
            sp: raw.sp,
            lr: raw.lr,
            xpsr: raw.xpsr,
            pcSymbol,
            lrSymbol,
            pcSymbolRaw,
            lrSymbolRaw,
            symbolication
        };
    }
}

module.exports = { FaultService };
