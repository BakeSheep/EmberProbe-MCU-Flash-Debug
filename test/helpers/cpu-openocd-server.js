"use strict";
const { FakeOpenOcdServer } = require("./fake-openocd-server");
const { metadata, taskBytes } = require("./cpu-load-fixture");
const { buildCpuLoadPlan } = require("../../src/services/cpuLoadModel");
const { REGISTERS } = require("../../src/services/cpuLoadSampler");
class CpuOpenOcdServer extends FakeOpenOcdServer {
    constructor({ h7 = false } = {}) {
        super();
        this.targets = [{ name: "cpu", type: "cortex_m", endian: "little" }];
        this.currentTarget = "cpu";
        if (h7) {
            this.targets = [
                { name: "stm32h7x.ap2", type: "mem_ap", endian: "little" },
                { name: "stm32h7x.cpu0", type: "cortex_m", endian: "little" }
            ];
            this.currentTarget = "stm32h7x.cpu0";
        }
        const data = metadata();
        this.plan = { ...buildCpuLoadPlan(data.result, data.layout), identity: { connection: 1 }, generation: 1 };
        const seedWord = (address, value) => {
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(value);
            this.seed(address, bytes);
        };
        seedWord(REGISTERS.cpuid, h7 ? 0x4100c270 : 0x4100c200);
        seedWord(REGISTERS.icsr, 0);
        seedWord(this.plan.currentAddress, 0x20000100);
        seedWord(this.plan.idleAddress, 0x20000100);
        seedWord(this.plan.schedulerAddress, 1);
        this.seed(0x20000100, taskBytes(this.plan, "Idle"));
        this.seed(0x20000200, [1, 2, 3, 4]);
    }
    _execute(command) {
        if (command.includes("cget -type")) {
            this.commands.push(command);
            return {
                ok: true,
                response: [
                    this.currentTarget,
                    ...this.targets.flatMap((entry) => [entry.name, entry.type, entry.endian])
                ].join("\n")
            };
        }
        const readsCommand = command.replace(/[A-Za-z_][A-Za-z0-9_.:-]* read_memory /g, "read_memory ");
        if (command.startsWith("join [list") && command.includes("curstate")) {
            this.commands.push(command);
            if (this.transientFailures) {
                this.transientFailures--;
                return { ok: false, response: "read failed" };
            }
            const reads = [...readsCommand.matchAll(/\[((?:ocd_)?read_memory 0x[\da-f]+ 32 1)\]/gi)].map(
                (m) => this._executeRead(m[1]).response
            );
            return {
                ok: true,
                response: [this.state, reads[0], reads[1], "0", reads[2], reads[3], this.state].join("\n")
            };
        }
        const result = super._execute(readsCommand);
        this.commands[this.commands.length - 1] = command;
        return result;
    }
}
module.exports = { CpuOpenOcdServer };
