"use strict";

const MAX_READ_TARGETS = 32;

class PeripheralViewService {
    constructor(options) {
        this.peripherals = options.peripherals;
        this.debugBridge = options.debugBridge;
    }

    async catalog() {
        const model = await this.peripherals.model();
        return {
            svd: model.svd,
            peripherals: model.peripherals.map((item) => ({
                name: item.name,
                description: item.description,
                baseAddress: item.baseAddressText,
                registerCount: item.registers.length,
                registerNames: item.registers.map((register) => register.name)
            }))
        };
    }

    async registers(name) {
        if (typeof name !== "string" || !name.trim()) throw new Error("Peripheral name is required");
        const listed = await this.peripherals.list({ peripheral: name });
        const peripheral = listed.peripherals.find((item) => item.name.toLowerCase() === name.toLowerCase());
        if (!peripheral)
            throw Object.assign(new Error(`Peripheral was not found: ${name}`), { code: "SVD_TARGET_NOT_FOUND" });
        return {
            name: peripheral.name,
            registers: peripheral.registers.map((register) => ({
                name: register.name,
                path: register.path,
                description: register.description,
                address: register.addressText,
                size: register.size,
                access: register.access,
                readAction: register.readAction,
                modifiedWriteValues: register.modifiedWriteValues,
                fields: register.fields.map((field) => ({
                    name: field.name,
                    path: field.path,
                    description: field.description,
                    bitOffset: field.bitOffset,
                    bitWidth: field.bitWidth,
                    access: field.access,
                    readAction: field.readAction,
                    modifiedWriteValues: field.modifiedWriteValues,
                    enumerations: field.enumerations
                }))
            }))
        };
    }

    async read(targets) {
        if (
            !Array.isArray(targets) ||
            !targets.length ||
            targets.length > MAX_READ_TARGETS ||
            targets.some((target) => typeof target !== "string" || !target.trim())
        ) {
            throw new Error(`Provide 1–${MAX_READ_TARGETS} register paths`);
        }
        this.debugBridge.assertPausedAccess();
        const expected = this.debugBridge.agentStatus();
        const registers = [];
        for (const target of [...new Set(targets)]) {
            try {
                const result = await this.peripherals.read({ targets: [target] });
                registers.push(result.registers[0]);
            } catch (error) {
                if (
                    [
                        "TARGET_NOT_PAUSED",
                        "DEBUG_STATE_CHANGED",
                        "DEBUG_SESSION_NOT_ACTIVE",
                        "DEBUG_SESSION_CONFLICT"
                    ].includes(error.code)
                )
                    throw error;
                registers.push({ path: target, error: error.message, code: error.code || "PERIPHERAL_READ_FAILED" });
            }
            const current = this.debugBridge.agentStatus();
            if (current.epoch !== expected.epoch || current.session?.id !== expected.session?.id)
                throw Object.assign(new Error("Debug target changed during peripheral refresh"), {
                    code: "DEBUG_STATE_CHANGED"
                });
        }
        return { session: this.debugBridge.agentStatus(), registers };
    }
}

module.exports = { PeripheralViewService, MAX_READ_TARGETS };
