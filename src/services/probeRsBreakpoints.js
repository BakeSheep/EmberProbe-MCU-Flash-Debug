"use strict";

const { sourceKey } = require("../dwarf/lineTable");

function instructionKey(bp) {
    const address = Number(bp.instructionReference) + Number(bp.offset || 0);
    return Number.isSafeInteger(address)
        ? JSON.stringify([address, bp.condition || null, bp.hitCondition || null])
        : JSON.stringify(bp);
}

class ProbeRsBreakpoints {
    constructor(request, resolveLines) {
        this.request = request;
        this.resolveLines = resolveLines;
        this.sources = new Map();
        this.instructions = [];
        this.queue = Promise.resolve();
    }

    handle(message) {
        const result = this.queue.then(() => this._handle(message));
        this.queue = result.catch(() => {});
        return result;
    }

    async _sync() {
        const unique = new Map();
        for (const bp of [
            ...this.instructions,
            ...[...this.sources.values()]
                .flat()
                .map((location) => ({ instructionReference: location.instructionReference }))
        ])
            unique.set(instructionKey(bp), { ...bp });
        if (unique.size > 256) throw new Error("Too many combined source and instruction breakpoints");
        const response = await this.request("setInstructionBreakpoints", { breakpoints: [...unique.values()] });
        if (!response.success) throw new Error(response.message || "Instruction breakpoints were rejected");
        return new Map([...unique.keys()].map((key, index) => [key, response.body?.breakpoints?.[index]]));
    }

    async _handle(message) {
        const args = message.arguments || {};
        if (message.command === "setInstructionBreakpoints") {
            this.instructions = args.breakpoints || [];
            const verified = await this._sync();
            return {
                success: true,
                body: {
                    breakpoints: this.instructions.map((bp) => verified.get(instructionKey(bp)) || { verified: false })
                }
            };
        }
        const response = await this.request("setBreakpoints", args);
        if (!response.success || typeof args.source?.path !== "string") return response;
        const breakpoints = response.body?.breakpoints || [];
        const unresolved = (args.breakpoints || [])
            .map((bp, index) => ({ bp, index }))
            .filter(
                ({ bp, index }) =>
                    !breakpoints[index]?.verified &&
                    /No valid breakpoint information|Cannot set breakpoint here/i.test(
                        breakpoints[index]?.message || ""
                    ) &&
                    !bp.condition &&
                    !bp.hitCondition &&
                    !bp.logMessage
            );
        const previous = this.sources.get(sourceKey(args.source.path));
        const mapped = [];
        try {
            const locations = unresolved.length
                ? await this.resolveLines(
                      args.source.path,
                      unresolved.map(({ bp }) => bp)
                  )
                : [];
            unresolved.forEach(({ index }, item) => {
                const location = locations[item];
                if (!Number.isSafeInteger(location?.address) || location.address <= 0 || location.address > 0xffffffff)
                    return;
                mapped.push({ ...location, index, instructionReference: `0x${location.address.toString(16)}` });
            });
        } catch (error) {
            for (const { index } of unresolved)
                breakpoints[index].message = `Source breakpoint lookup failed: ${String(error.message).slice(0, 500)}`;
        }
        if (mapped.length) this.sources.set(sourceKey(args.source.path), mapped);
        else this.sources.delete(sourceKey(args.source.path));
        if (mapped.length || previous?.length) {
            const verified = await this._sync();
            for (const location of mapped) {
                const instruction = verified.get(instructionKey(location));
                breakpoints[location.index] = {
                    ...breakpoints[location.index],
                    ...instruction,
                    verified: instruction?.verified === true,
                    source: args.source,
                    line: location.line,
                    column: location.column,
                    instructionReference: location.instructionReference,
                    message: instruction?.verified
                        ? undefined
                        : instruction?.message || "Instruction breakpoint was not verified"
                };
            }
        }
        return response;
    }
}

module.exports = { ProbeRsBreakpoints };
