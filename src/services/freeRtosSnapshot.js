"use strict";

const { quote } = require("../debug/mi");
const { fileKey } = require("../debug/symbolDirectory");

const LIMITS = Object.freeze({ tasks: 256, nodes: 4096, bytes: 256 * 1024, stack: 64 * 1024, timeMs: 15000 });

function numeric(value) {
    const match = String(value).match(/^\s*(0x[\da-f]+|\d+)(?=\s|$)/i);
    if (!match || BigInt(match[1]) > 0xffffffffn) throw new Error("Invalid ARM32 RTOS value");
    return Number(BigInt(match[1]));
}
const addressText = (address) => `0x${address.toString(16)}`;

// Decode only through GDB's typed layout and bounded paused memory reads. Never call the inferior.
class FreeRtosSnapshot {
    constructor(session) {
        this.session = session;
    }
    async snapshot(options = {}) {
        const includeStackUsage = options.includeStackUsage === undefined ? true : options.includeStackUsage === true;
        this.session.paused();
        const generation = this.session.variableStore.snapshot();
        const result = { kernel: { name: "FreeRTOS", supported: false }, tasks: [], partial: false, diagnostics: [] };
        const context = { generation, bytes: 0, nodes: 0, deadline: Date.now() + LIMITS.timeMs, result };
        try {
            const directory = await this.session.symbolDirectory.load();
            this.check(context);
            const multiImage = (this.session.config?.symbolFiles?.length || 0) > 1;
            const primary = this.session.config?.primarySymbolFile;
            if (multiImage && !primary) throw new Error("FreeRTOS requires a primary symbol image");
            const entries = multiImage ? directory.filter((entry) => entry.image === fileKey(primary)) : directory;
            const current = entries.filter((entry) => entry.name === "pxCurrentTCB");
            if (entries.some((entry) => entry.name === "pxCurrentTCBs"))
                throw new Error("FreeRTOS SMP snapshots are not supported");
            if (current.length !== 1 || !current[0].expression)
                throw new Error("FreeRTOS pxCurrentTCB is missing or ambiguous in the primary image");
            const symbol = (name) => {
                const matches = entries.filter(
                    (entry) => entry.name === name && (!entry.isStatic || entry.file === current[0].file)
                );
                if (matches.length !== 1 || !matches[0].expression)
                    throw new Error(`FreeRTOS ${name} is missing or ambiguous`);
                return matches[0].expression;
            };
            if (multiImage) {
                const expected = await this.evaluate(`(unsigned long)&(${current[0].expression})`, context);
                const actual = await this.evaluate("(unsigned long)&(pxCurrentTCB)", context);
                if (
                    !current[0].symbolAddress ||
                    expected !== Number(BigInt(current[0].symbolAddress)) ||
                    actual !== expected
                )
                    throw new Error("GDB RTOS symbol lookup does not select the primary image");
                result.kernel.symbolImage = primary;
            }
            const width = await this.evaluate("sizeof(void*)", context);
            const target = await this.session.captureConsole(async () => {
                await this.session.mi.command('-interpreter-exec console "show architecture"');
                await this.session.mi.command('-interpreter-exec console "show endian"');
            });
            this.check(context);
            if (width !== 4 || !/little endian/i.test(target) || !/\barmv[678][\w.-]*m\b/i.test(target))
                throw new Error(
                    "FreeRTOS snapshots currently require a little-endian single-core Cortex-M ARM32 target"
                );
            const currentTcb = await this.evaluate(current[0].expression, context);
            const optionalSymbol = async (name) => {
                const matches = entries.filter(
                    (entry) => entry.name === name && (!entry.isStatic || entry.file === current[0].file)
                );
                if (matches.length !== 1 || !matches[0].expression) return undefined;
                try {
                    return await this.evaluate(matches[0].expression, context);
                } catch (error) {
                    this.check(context);
                    this.diagnostic(context, `${name}: ${error.message}`);
                    return undefined;
                }
            };
            const scheduler = await optionalSymbol("xSchedulerRunning");
            const taskCount = await optionalSymbol("uxCurrentNumberOfTasks");
            result.kernel.state = scheduler === 0 ? "not-started" : scheduler === 1 ? "running" : "unknown";
            // Before the scheduler starts FreeRTOS lists are zero-initialized, not
            // circular lists yet. xSchedulerRunning is the strongest signal here:
            // uxCurrentNumberOfTasks is frequently optimized out in a debug build,
            // so requiring that optional symbol made the first stop walk BSS zeros
            // and report fake list corruption. When the scheduler symbol is absent,
            // retain the stricter current-TCB/task-count corroboration.
            const preScheduler = currentTcb === 0 && (scheduler === 0 || (scheduler === undefined && taskCount === 0));
            if (preScheduler) {
                this.check(context);
                result.kernel.supported = true;
                result.kernel.state = scheduler === 0 ? "not-started" : "no-tasks";
                return result;
            }
            // A null pxCurrentTCB with neither kernel static available is undecidable. Walking the
            // zero-initialized lists would report them as corrupt, which is what the corroboration
            // above exists to prevent; say that the state cannot be determined instead.
            if (currentTcb === 0 && scheduler === undefined && taskCount === undefined) {
                this.check(context);
                result.kernel.supported = true;
                this.diagnostic(
                    context,
                    "pxCurrentTCB is null and neither xSchedulerRunning nor uxCurrentNumberOfTasks is available, so a pre-scheduler stop cannot be told apart from list corruption"
                );
                return result;
            }
            // In multi-image sessions derive every layout from a primary-image variable. A global
            // typedef name can resolve to a different firmware's incompatible definition.
            const ready = multiImage ? symbol("pxReadyTasksLists") : null;
            const tcb = await this.layout(
                "TCB_t",
                ["pxTopOfStack", "uxPriority", "pxStack", "pcTaskName"],
                context,
                multiImage ? `*(${current[0].expression})` : null
            );
            for (const field of ["uxBasePriority", "pxEndOfStack", "ulRunTimeCounter", "xEventListItem.pvContainer"])
                await this.optionalField(tcb, field, context);
            const list = await this.layout(
                "List_t",
                ["uxNumberOfItems", "xListEnd", "xListEnd.pxNext"],
                context,
                multiImage ? `(${ready})[0]` : null
            );
            const item = await this.layout(
                "ListItem_t",
                ["pxNext", "pvOwner"],
                context,
                multiImage ? `*((${ready})[0].xListEnd.pxNext)` : null
            );
            for (const { type, fields } of [
                { type: tcb, fields: ["pxTopOfStack", "uxPriority", "pxStack"] },
                { type: list, fields: ["uxNumberOfItems", "xListEnd.pxNext"] },
                { type: item, fields: ["pxNext", "pvOwner"] }
            ])
                for (const field of fields)
                    if (type.fields[field].size !== 4) throw new Error(`Unsupported ${type.name}.${field} width`);
            if (tcb.fields.pcTaskName.size > 256) throw new Error("Unsupported FreeRTOS task name capacity");
            const running = scheduler === 0 ? 0 : currentTcb;
            result.kernel.supported = true;
            result.kernel.layout = "GDB typed Cortex-M ARM32";
            const tasks = new Map();
            const readTask = async (address, state) => {
                if (tasks.has(address)) {
                    const task = tasks.get(address);
                    if (task.state !== "running" && state === "pending-ready") task.state = state;
                    return;
                }
                if (tasks.size >= LIMITS.tasks) throw new Error("FreeRTOS task budget exceeded");
                const bytes = await this.read(address, tcb.size, context);
                const number = (field) => this.field(bytes, tcb, field);
                const name = tcb.fields.pcTaskName;
                const nameBytes = bytes.subarray(name.offset, name.offset + name.size);
                const terminator = nameBytes.indexOf(0);
                const task = {
                    taskKey: addressText(address),
                    tcbAddress: addressText(address),
                    name: nameBytes.subarray(0, terminator < 0 ? nameBytes.length : terminator).toString("utf8"),
                    state: address === running ? "running" : state,
                    priority: number("uxPriority"),
                    stack: {
                        savedPointer: addressText(number("pxTopOfStack")),
                        baseAddress: addressText(number("pxStack"))
                    }
                };
                if (tcb.fields.uxBasePriority) task.basePriority = number("uxBasePriority");
                if (tcb.fields.ulRunTimeCounter) task.runtime = { counter: number("ulRunTimeCounter") };
                if (
                    state === "suspended" &&
                    tcb.fields["xEventListItem.pvContainer"] &&
                    number("xEventListItem.pvContainer")
                )
                    task.state = address === running ? "running" : "blocked";
                tasks.set(address, task);
                result.tasks.push(task);
                if (tcb.fields.pxEndOfStack) {
                    const base = number("pxStack"),
                        end = number("pxEndOfStack");
                    if (base && end >= base && end % 4 === 0 && base % 4 === 0 && end - base < 16 * 1024 * 1024) {
                        const total = end - base + 4;
                        task.stack.totalBytes = total;
                        if (!includeStackUsage) return;
                        const scan = Math.min(total, LIMITS.stack);
                        // FreeRTOS Cortex-M stacks grow down; upstream's fill byte is 0xa5.
                        const fill = await this.read(base, scan, context);
                        let unused = 0;
                        while (unused < fill.length && fill[unused] === 0xa5) unused++;
                        task.stack.fillEstimate = {
                            unusedBytes: unused,
                            scannedBytes: scan,
                            complete: unused < scan || scan === total
                        };
                        if (task.stack.fillEstimate.complete)
                            task.stack.fillEstimate.usedPercent = ((total - unused) * 100) / total;
                        else this.diagnostic(context, `Stack fill scan truncated for ${task.name}`);
                    } else this.diagnostic(context, `Stack bounds are unavailable for ${task.name}`);
                }
            };
            const walk = async (address, state) => {
                const header = await this.read(address, list.size, context);
                const length = this.field(header, list, "uxNumberOfItems");
                if (length > LIMITS.nodes) throw new Error("Invalid FreeRTOS list length");
                const sentinel = address + list.fields.xListEnd.offset;
                let next = this.field(header, list, "xListEnd.pxNext");
                const seen = new Set();
                while (next !== sentinel) {
                    if (seen.has(next) || seen.size >= length) throw new Error("Corrupt FreeRTOS list cycle or length");
                    if (++context.nodes > LIMITS.nodes) throw new Error("FreeRTOS list node budget exceeded");
                    seen.add(next);
                    const node = await this.read(next, item.size, context);
                    await readTask(this.field(node, item, "pvOwner"), state);
                    next = this.field(node, item, "pxNext");
                }
                if (seen.size !== length) throw new Error("FreeRTOS list ended before its declared length");
            };
            const inspect = async (name, state, pointer = false) => {
                try {
                    const expression = symbol(name);
                    await walk(
                        await this.evaluate(pointer ? expression : `(unsigned long)&(${expression})`, context),
                        state
                    );
                } catch (error) {
                    this.check(context);
                    this.diagnostic(context, `${name}: ${error.message}`);
                }
            };
            try {
                const ready = symbol("pxReadyTasksLists");
                const count = await this.evaluate(
                    `sizeof(${ready}) / sizeof(${multiImage ? `(${ready})[0]` : "List_t"})`,
                    context
                );
                if (!count || count > 256) throw new Error("Unsupported FreeRTOS ready priority count");
                const base = await this.evaluate(`(unsigned long)&(${ready})`, context);
                for (let priority = 0; priority < count; priority++) await walk(base + priority * list.size, "ready");
            } catch (error) {
                this.check(context);
                this.diagnostic(context, `pxReadyTasksLists: ${error.message}`);
            }
            for (const { name, state, pointer } of [
                { name: "pxDelayedTaskList", state: "blocked", pointer: true },
                { name: "pxOverflowDelayedTaskList", state: "blocked", pointer: true },
                { name: "xSuspendedTaskList", state: "suspended", pointer: false },
                { name: "xPendingReadyList", state: "pending-ready", pointer: false },
                { name: "xTasksWaitingTermination", state: "deleted", pointer: false }
            ])
                await inspect(name, state, pointer);
            if (currentTcb && !tasks.has(currentTcb)) {
                try {
                    await readTask(currentTcb, scheduler === 0 ? "ready" : "running");
                } catch (error) {
                    this.check(context);
                    this.diagnostic(context, `Current task: ${error.message}`);
                }
            }
        } catch (error) {
            // A resume or a new stop invalidates the whole response, not merely one task.
            this.session.variableStore.check(generation);
            this.diagnostic(context, error.message);
        }
        this.session.variableStore.check(generation);
        return result;
    }
    check(context) {
        this.session.variableStore.check(context.generation);
        if (Date.now() > context.deadline) throw new Error("FreeRTOS snapshot time budget exceeded");
    }
    diagnostic(context, message) {
        context.result.partial = true;
        if (context.result.diagnostics.length < 64) context.result.diagnostics.push(message);
    }
    async evaluate(expression, context) {
        this.check(context);
        const result = await this.session.mi.command(`-data-evaluate-expression ${quote(expression)}`);
        this.check(context);
        return numeric(result.value);
    }
    async layout(name, fields, context, instance = null) {
        const size = await this.evaluate(`sizeof(${instance ? `(${instance})` : name})`, context);
        if (!size || size > 4096) throw new Error(`Unsupported ${name} size`);
        const layout = { name, instance, size, fields: {} };
        for (const field of fields) await this.addField(layout, field, context);
        return layout;
    }
    async addField(layout, field, context) {
        const member = layout.instance ? `(${layout.instance}).${field}` : `((${layout.name}*)0)->${field}`;
        const offset = await this.evaluate(
            `(unsigned long)&(${member})${layout.instance ? ` - (unsigned long)&(${layout.instance})` : ""}`,
            context
        );
        const size = await this.evaluate(`sizeof(${member})`, context);
        if (!size || offset + size > layout.size) throw new Error(`Invalid ${layout.name}.${field} layout`);
        layout.fields[field] = { offset, size };
    }
    async optionalField(layout, field, context) {
        try {
            await this.addField(layout, field, context);
            const size = layout.fields[field].size;
            if (field === "ulRunTimeCounter" ? ![4, 8].includes(size) : size !== 4)
                throw new Error(`Unsupported optional field width: ${size}`);
        } catch (error) {
            delete layout.fields[field];
            this.check(context);
            // These members depend on FreeRTOSConfig.h. Absence is supported;
            // invalid sizes/layouts and transport errors still need diagnostics.
            if (!/\b(?:no (?:member|field)(?: or method)? named|has no (?:member|field) named)\b/i.test(error.message))
                this.diagnostic(context, `${layout.name}.${field}: ${error.message}`);
        }
    }
    field(bytes, layout, name) {
        const field = layout.fields[name];
        if (name === "ulRunTimeCounter" && field.size === 8) return bytes.readBigUInt64LE(field.offset).toString();
        if (![1, 2, 4].includes(field.size)) throw new Error(`Unsupported ${layout.name}.${name} width`);
        return bytes.readUIntLE(field.offset, field.size);
    }
    async read(address, length, context) {
        this.check(context);
        if (!Number.isSafeInteger(address) || address <= 0 || address % 4 || address + length > 0x100000000)
            throw new Error("Invalid FreeRTOS memory address");
        if (
            !Number.isSafeInteger(length) ||
            length <= 0 ||
            length > LIMITS.stack ||
            context.bytes + length > LIMITS.bytes
        )
            throw new Error("FreeRTOS memory budget exceeded");
        context.bytes += length;
        const result = await this.session.mi.command(`-data-read-memory-bytes ${addressText(address)} ${length}`);
        this.check(context);
        const blocks = result.memory;
        if (
            !Array.isArray(blocks) ||
            blocks.length !== 1 ||
            numeric(blocks[0].begin) !== address ||
            !new RegExp(`^[\\da-f]{${length * 2}}$`, "i").test(blocks[0].contents || "")
        )
            throw new Error("Incomplete FreeRTOS memory read");
        return Buffer.from(blocks[0].contents, "hex");
    }
}

module.exports = { FreeRtosSnapshot, LIMITS, numeric };
