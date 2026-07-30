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
        let symbolication = "ok";
        try {
            const functions = functionsProvider() || [];
            const symbolize = (hex) => {
                const fn = this.elfSymbols.nearestFunction(functions, parseInt(hex, 16));
                return fn ? `${fn.name}+0x${fn.offset.toString(16).toUpperCase()}` : "";
            };
            if (raw.pc) pcSymbol = symbolize(raw.pc);
            if (raw.lr) lrSymbol = symbolize(raw.lr);
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
            symbolication
        };
    }
}

module.exports = { FaultService };
