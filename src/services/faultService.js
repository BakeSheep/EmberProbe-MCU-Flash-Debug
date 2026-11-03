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
        // symbolize returns the readable display name, the raw (mangled) name for cross-checking and the function
        let symbolize = (_hex) => ({ display: "", raw: "", function: "" });
        try {
            const functions = functionsProvider() || [];
            symbolize = (hex) => {
                const fn = this.elfSymbols.nearestFunction(functions, parseInt(hex, 16));
                if (!fn) return { display: "", raw: "", function: "" };
                const off = `+0x${fn.offset.toString(16).toUpperCase()}`;
                return {
                    display: `${fn.displayName || fn.name}${off}`,
                    raw: `${fn.name}${off}`,
                    function: fn.displayName || fn.name
                };
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
        const execution = this.execution(raw, symbolize);
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
            symbolication,
            ...(execution ? { execution } : {}),
            ...(raw.pcSamples?.length ? { stall: stallVerdict(raw.pc, raw.pcSamples, symbolize) } : {})
        };
    }

    // Where the halted core was executing: thread or handler mode, the exception and its handler from the vector table
    // (named by the ELF, e.g. UART7_IRQHandler or Default_Handler for an unhandled interrupt) and the interrupt masks
    execution(raw, symbolize) {
        const context = this.faultInfo.decodeExecutionContext?.(raw);
        if (!context) return null;
        if (context.mode === "handler" && raw.handler) {
            const handler = symbolize(raw.handler);
            context.exception.handlerAddress = raw.handler;
            if (handler.function) {
                context.exception.handler = handler.function;
                if (context.exception.irq !== undefined && /_IRQHandler$/.test(handler.function))
                    context.exception.name = handler.function.replace(/_IRQHandler$/, "_IRQn");
            }
        }
        return context;
    }
}

// PC samples taken while resuming briefly between halts: all in one function means the core keeps executing it (a
// wait loop or an endless loop), different functions mean the firmware is still making progress
function stallVerdict(pc, samples, symbolize) {
    const all = [pc, ...samples].filter(Boolean);
    const entries = all.map((address) => ({ pc: address, symbol: symbolize(address).display }));
    const functions = all.map((address) => symbolize(address).function);
    const addresses = all.map((address) => parseInt(address, 16));
    const span = Math.max(...addresses) - Math.min(...addresses);
    let verdict = span <= 64 ? "tightLoop" : "unknown";
    // Without symbols for every sample only a narrow address span is conclusive
    if (functions.every(Boolean) && span > 64) verdict = new Set(functions).size === 1 ? "sameFunction" : "progressing";
    return { verdict, samples: entries };
}

module.exports = { FaultService };
