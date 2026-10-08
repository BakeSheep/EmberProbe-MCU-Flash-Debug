"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { resolveSvdDerivation } = require("./svdDerivation");
const {
    parseWriteConstraint,
    assertRegisterConstraints,
    readableEnumeration,
    writableEnumeration,
    enumMatches
} = require("./svdWriteConstraints");

const SUPPORTED_SIZES = new Set([8, 16, 32, 64]);
const NORMAL_WRITE_ACCESS = "read-write";
// SVD 数值受寄存器宽度约束（≤64 位），任何合法表示都远短于此上限；
// 超过即拒绝，避免逐字符 BigInt 移位（Θ(L²)）或超长十进制 BigInt 解析卡死扩展宿主。
const MAX_SVD_VALUE_CHARS = 256;

function consumeBudget(budget) {
    if (--budget.remaining < 0)
        throw Object.assign(new Error("SVD expansion budget exceeded"), { code: "SVD_BUDGET_EXCEEDED" });
}

function array(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function text(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return String(value["#text"] ?? value._text ?? "").trim();
    return String(value).trim();
}

function integer(value, label, options = {}) {
    const raw = text(value).replace(/_/g, "");
    if (!raw && options.optional) return undefined;
    if (raw.length > MAX_SVD_VALUE_CHARS)
        throw Object.assign(new Error(`SVD integer for ${label} exceeds ${MAX_SVD_VALUE_CHARS} characters`), {
            code: "INVALID_SVD_VALUE"
        });
    let parsed;
    if (/^#[01]+$/i.test(raw)) parsed = BigInt(`0b${raw.slice(1)}`);
    else if (/^0b[01]+$/i.test(raw)) parsed = BigInt(raw);
    else if (/^0x[0-9a-f]+$/i.test(raw)) parsed = BigInt(raw);
    else if (/^[+]?[0-9]+$/u.test(raw)) parsed = BigInt(raw.replace(/^[+]/u, ""));
    else throw Object.assign(new Error(`Invalid SVD integer for ${label}: ${raw}`), { code: "INVALID_SVD_VALUE" });
    if (!options.bigint && parsed > BigInt(Number.MAX_SAFE_INTEGER))
        throw Object.assign(new Error(`SVD integer exceeds the supported address range for ${label}`), {
            code: "INVALID_SVD_ADDRESS"
        });
    return options.bigint ? parsed : Number(parsed);
}

function inherit(parent, node) {
    return {
        size: integer(node?.size, "register size", { optional: true }) ?? parent.size,
        access: text(node?.access) || parent.access,
        resetValue: integer(node?.resetValue, "reset value", { optional: true, bigint: true }) ?? parent.resetValue,
        resetMask: integer(node?.resetMask, "reset mask", { optional: true, bigint: true }) ?? parent.resetMask,
        readAction: text(node?.readAction) || parent.readAction,
        modifiedWriteValues: text(node?.modifiedWriteValues) || parent.modifiedWriteValues,
        writeConstraint: parseWriteConstraint(node?.writeConstraint, integer) ?? parent.writeConstraint
    };
}

function dimIndexes(node, count) {
    const raw = text(node?.dimIndex);
    if (!raw) return Array.from({ length: count }, (_, index) => String(index));
    if (raw.includes(",")) {
        const values = raw.split(",").map((value) => value.trim());
        if (values.length === count) return values;
    }
    const range = raw.match(/^([0-9]+)-([0-9]+)$/u);
    if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && Math.abs(end - start) + 1 === count)
            return Array.from({ length: count }, (_, index) => String(start + index * Math.sign(end - start || 1)));
    }
    throw Object.assign(new Error(`Invalid SVD dimIndex: ${raw}`), { code: "INVALID_SVD_DIMENSION" });
}

function expandDim(node) {
    const count = integer(node?.dim, "dim", { optional: true });
    if (count === undefined) return [{ node, index: null, offset: 0 }];
    if (!Number.isInteger(count) || count < 1 || count > 4096)
        throw Object.assign(new Error(`Invalid SVD dim count: ${count}`), { code: "INVALID_SVD_DIMENSION" });
    const increment = integer(node?.dimIncrement, "dimIncrement");
    return dimIndexes(node, count).map((index, ordinal) => ({ node, index, offset: ordinal * increment }));
}

function expandedName(node, index) {
    const name = text(node?.name);
    if (!name) throw Object.assign(new Error("SVD element is missing a name"), { code: "INVALID_SVD_STRUCTURE" });
    if (index === null) return name;
    if (name.includes("%s")) return name.replace(/%s/g, index);
    return `${name}[${index}]`;
}

function fieldBits(node) {
    let offset = integer(node?.bitOffset, "field bitOffset", { optional: true });
    let width = integer(node?.bitWidth, "field bitWidth", { optional: true });
    if (offset === undefined) offset = integer(node?.lsb, "field lsb", { optional: true });
    if (width === undefined) {
        const msb = integer(node?.msb, "field msb", { optional: true });
        if (msb !== undefined && offset !== undefined) width = msb - offset + 1;
    }
    if (offset === undefined || width === undefined) {
        const match = text(node?.bitRange).match(/^\[([0-9]+):([0-9]+)\]$/u);
        if (match) {
            offset = Number(match[2]);
            width = Number(match[1]) - offset + 1;
        }
    }
    if (!Number.isInteger(offset) || !Number.isInteger(width) || offset < 0 || width < 1)
        throw Object.assign(new Error(`Invalid SVD field bit range for ${text(node?.name)}`), {
            code: "INVALID_SVD_FIELD"
        });
    return { bitOffset: offset, bitWidth: width };
}

function enumerations(node, budget) {
    if (budget.enumerations.has(node)) {
        const cached = budget.enumerations.get(node);
        for (const _entry of cached) consumeBudget(budget);
        return cached;
    }
    const result = [];
    for (const group of array(node?.enumeratedValues)) {
        const usage = text(group?.usage) || "read-write";
        if (!["read", "write", "read-write"].includes(usage))
            throw Object.assign(new Error("Invalid enumeration usage"), { code: "INVALID_SVD_VALUE" });
        for (const entry of array(group?.enumeratedValue)) {
            if (!text(entry?.name) || entry?.value === undefined) continue;
            consumeBudget(budget);
            const parsed = enumerationValue(entry.value);
            result.push({
                name: text(entry.name),
                description: text(entry.description),
                value: parsed.value,
                mask: parsed.mask,
                usage
            });
        }
    }
    const shared = Object.freeze(result.map(Object.freeze));
    budget.enumerations.set(node, shared);
    return shared;
}

function enumerationValue(rawValue) {
    const raw = text(rawValue).replace(/_/g, "");
    const binary = raw.match(/^(?:#|0b)([01x]+)$/i);
    if (!binary) {
        const value = integer(raw, "enumerated value", { bigint: true });
        return { value, mask: null };
    }
    // 逐字符 `<<= 1n` 是 Θ(L²)：先按位上限拒绝，杜绝超长二进制占位符卡死事件循环。
    if (binary[1].length > MAX_SVD_VALUE_CHARS)
        throw Object.assign(new Error(`SVD enumerated value exceeds ${MAX_SVD_VALUE_CHARS} bits`), {
            code: "INVALID_SVD_VALUE"
        });
    let value = 0n;
    let mask = 0n;
    for (const digit of binary[1].toLowerCase()) {
        value <<= 1n;
        mask <<= 1n;
        if (digit !== "x") {
            mask |= 1n;
            if (digit === "1") value |= 1n;
        }
    }
    return { value, mask };
}

function normalizeFields(registerNode, register, defaults, budget) {
    const raw = array(registerNode?.fields?.field);
    return raw.flatMap((fieldNode) =>
        expandDim(fieldNode).map(({ node, index, offset }) => {
            consumeBudget(budget);
            const bits = fieldBits(node);
            const name = expandedName(node, index);
            const properties = inherit(defaults, node);
            const bitOffset = bits.bitOffset + offset;
            if (bitOffset + bits.bitWidth > register.size)
                throw Object.assign(new Error(`SVD field exceeds register width: ${register.path}.${name}`), {
                    code: "INVALID_SVD_FIELD"
                });
            return {
                name,
                path: `${register.path}.${name}`,
                description: text(node?.description),
                bitOffset,
                bitWidth: bits.bitWidth,
                access: properties.access || register.access,
                readAction: properties.readAction || register.readAction,
                modifiedWriteValues: properties.modifiedWriteValues || register.modifiedWriteValues,
                writeConstraint: properties.writeConstraint,
                enumerations: enumerations(node, budget)
            };
        })
    );
}

function normalizeRegister(node, peripheral, prefix, baseOffset, defaults, index, dimOffset, budget) {
    consumeBudget(budget);
    const name = expandedName(node, index);
    const offset = integer(node?.addressOffset, "register addressOffset") + baseOffset + dimOffset;
    const properties = inherit(defaults, node);
    if (!SUPPORTED_SIZES.has(properties.size))
        throw Object.assign(new Error(`Unsupported SVD register size ${properties.size} for ${name}`), {
            code: "UNSUPPORTED_SVD_REGISTER_SIZE"
        });
    const path = [peripheral.name, prefix, name].filter(Boolean).join(".");
    const address = peripheral.baseAddress + offset;
    if (!Number.isSafeInteger(address) || address < 0 || address + properties.size / 8 > 0x100000000)
        throw Object.assign(new Error(`Invalid SVD register address for ${path}`), { code: "INVALID_SVD_ADDRESS" });
    const register = {
        name,
        path,
        description: text(node?.description),
        address,
        addressText: hex(BigInt(address)),
        size: properties.size,
        bytes: properties.size / 8,
        access: properties.access || "read-write",
        resetValue: properties.resetValue,
        resetMask: properties.resetMask,
        readAction: properties.readAction,
        modifiedWriteValues: properties.modifiedWriteValues,
        writeConstraint: properties.writeConstraint,
        fields: []
    };
    register.fields = normalizeFields(node, register, properties, budget);
    return register;
}

function normalizeRegisterGroup(group, peripheral, prefix, baseOffset, defaults, budget, depth = 0) {
    if (depth > 32) throw Object.assign(new Error("SVD nesting budget exceeded"), { code: "SVD_BUDGET_EXCEEDED" });
    consumeBudget(budget);
    const output = [];
    const registers = array(group?.register);
    for (const registerNode of registers) {
        for (const item of expandDim(registerNode))
            output.push(
                normalizeRegister(item.node, peripheral, prefix, baseOffset, defaults, item.index, item.offset, budget)
            );
    }
    const clusters = array(group?.cluster);
    for (const clusterNode of clusters) {
        for (const item of expandDim(clusterNode)) {
            const clusterName = expandedName(item.node, item.index);
            const offset = integer(item.node?.addressOffset, "cluster addressOffset") + baseOffset + item.offset;
            const clusterDefaults = inherit(defaults, item.node);
            output.push(
                ...normalizeRegisterGroup(
                    item.node,
                    peripheral,
                    [prefix, clusterName].filter(Boolean).join("."),
                    offset,
                    clusterDefaults,
                    budget,
                    depth + 1
                )
            );
        }
    }
    return output;
}

function hex(value, bits) {
    const width = bits ? Math.ceil(bits / 4) : 1;
    return `0x${BigInt(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseSvd(buffer, sourcePath = "") {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (!buffer.length || buffer.length > 32 * 1024 * 1024)
        throw Object.assign(new Error("SVD size limit exceeded"), { code: "INVALID_SVD_SIZE" });
    const xml = buffer.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw Object.assign(new Error("SVD files with DTD or external entities are not allowed"), {
            code: "UNSAFE_XML"
        });
    const valid = XMLValidator.validate(xml);
    if (valid !== true)
        throw Object.assign(new Error(`Invalid SVD XML: ${valid.err?.msg || "parse error"}`), {
            code: "INVALID_SVD_XML"
        });
    const parsed = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        allowBooleanAttributes: false,
        trimValues: true
    }).parse(xml);
    const deviceNode = parsed?.device ? resolveSvdDerivation(parsed.device) : null;
    if (!deviceNode) throw Object.assign(new Error("SVD device element is missing"), { code: "INVALID_SVD_STRUCTURE" });
    const endian = text(deviceNode?.cpu?.endian) || "little";
    if (!new Set(["little", "big"]).has(endian))
        throw Object.assign(new Error(`Unsupported or ambiguous SVD endian: ${endian}`), {
            code: "UNSUPPORTED_SVD_ENDIAN"
        });
    const budget = { remaining: 100000, enumerations: new WeakMap() };
    const defaults = inherit({ size: 32, access: "read-write" }, deviceNode);
    const peripheralNodes = array(deviceNode?.peripherals?.peripheral);
    const peripherals = [];
    const registersByPath = new Map();
    const fieldsByPath = new Map();
    for (const node of peripheralNodes) {
        for (const item of expandDim(node)) {
            const name = expandedName(item.node, item.index);
            const peripheral = {
                name,
                path: name,
                description: text(item.node?.description),
                baseAddress: integer(item.node?.baseAddress, "peripheral baseAddress") + item.offset,
                baseAddressText: "",
                registers: []
            };
            peripheral.baseAddressText = hex(BigInt(peripheral.baseAddress));
            const peripheralDefaults = inherit(defaults, item.node);
            peripheral.registers = normalizeRegisterGroup(
                item.node?.registers || {},
                peripheral,
                "",
                0,
                peripheralDefaults,
                budget
            );
            for (const register of peripheral.registers) {
                if (registersByPath.has(register.path.toLowerCase()))
                    throw Object.assign(new Error(`Duplicate SVD register path: ${register.path}`), {
                        code: "INVALID_SVD_STRUCTURE"
                    });
                registersByPath.set(register.path.toLowerCase(), register);
                for (const field of register.fields) fieldsByPath.set(field.path.toLowerCase(), { register, field });
            }
            peripherals.push(peripheral);
        }
    }
    if (!peripherals.length)
        throw Object.assign(new Error("SVD contains no peripherals"), { code: "INVALID_SVD_STRUCTURE" });
    return {
        svd: {
            path: sourcePath,
            sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
            device: text(deviceNode.name),
            vendor: text(deviceNode.vendor),
            version: text(deviceNode.version),
            endian
        },
        peripherals,
        registersByPath,
        fieldsByPath
    };
}

function decodeInteger(bytes, endian) {
    const data = Buffer.from(bytes);
    let value = 0n;
    if (endian === "little") {
        for (let index = data.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[index]);
    } else {
        for (const byte of data) value = (value << 8n) | BigInt(byte);
    }
    return value;
}

function encodeInteger(value, bytes, endian) {
    let remaining = BigInt(value);
    const data = Buffer.alloc(bytes);
    for (let index = 0; index < bytes; index += 1) {
        const target = endian === "little" ? index : bytes - index - 1;
        data[target] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return Uint8Array.from(data);
}

function fieldValue(registerValue, field) {
    return (registerValue >> BigInt(field.bitOffset)) & ((1n << BigInt(field.bitWidth)) - 1n);
}

function decodedField(registerValue, field) {
    const value = fieldValue(registerValue, field);
    const enumeration = field.enumerations.find((entry) => readableEnumeration(entry) && enumMatches(entry, value));
    return {
        path: field.path,
        name: field.name,
        bitOffset: field.bitOffset,
        bitWidth: field.bitWidth,
        access: field.access,
        value: hex(value, field.bitWidth),
        valueText: value.toString(10),
        ...(enumeration ? { enum: enumeration.name, enumDescription: enumeration.description } : {})
    };
}

function resolveTarget(model, target) {
    const key = String(target || "")
        .trim()
        .toLowerCase();
    const register = model.registersByPath.get(key);
    if (register) return { register, field: null };
    const field = model.fieldsByPath.get(key);
    if (field) return field;
    throw Object.assign(new Error(`SVD target was not found: ${target}`), {
        code: "SVD_TARGET_NOT_FOUND",
        details: { target }
    });
}

function assertReadable(register) {
    const width = register.size / 8;
    if (![1, 2, 4, 8].includes(width) || register.address % width !== 0)
        throw Object.assign(new Error(`Unsupported or unaligned register access: ${register.path}`), {
            code: "PERIPHERAL_ADDRESS_UNALIGNED",
            details: { address: register.address, width }
        });
    if (register.access === "write-only")
        throw Object.assign(new Error(`Register is write-only: ${register.path}`), {
            code: "PERIPHERAL_READ_NOT_ALLOWED"
        });
    const fieldSideEffect = register.fields.find((field) => field.readAction);
    const readAction = register.readAction || fieldSideEffect?.readAction;
    if (readAction)
        throw Object.assign(new Error(`Register read has side effects (${readAction}): ${register.path}`), {
            code: "PERIPHERAL_READ_SIDE_EFFECT",
            details: { target: fieldSideEffect?.path || register.path, readAction }
        });
}

function assertWritable(register, field) {
    if (
        register.access !== NORMAL_WRITE_ACCESS ||
        (field && field.access !== NORMAL_WRITE_ACCESS) ||
        register.fields.some((entry) => entry.access !== NORMAL_WRITE_ACCESS)
    )
        throw Object.assign(
            new Error(`Peripheral target is not ordinary read-write: ${field?.path || register.path}`),
            {
                code: "PERIPHERAL_WRITE_NOT_ALLOWED"
            }
        );
    assertReadable(register);
    if (
        register.modifiedWriteValues ||
        field?.modifiedWriteValues ||
        register.fields.some((entry) => entry.modifiedWriteValues)
    )
        throw Object.assign(
            new Error(`Peripheral target has special write semantics: ${field?.path || register.path}`),
            {
                code: "PERIPHERAL_WRITE_SEMANTICS_UNSUPPORTED",
                details: {
                    target: field?.path || register.path,
                    modifiedWriteValues: field?.modifiedWriteValues || register.modifiedWriteValues
                }
            }
        );
}

function parseWriteValue(raw, field, bits) {
    const valueText = String(raw ?? "").trim();
    let value;
    if (field) {
        const enumeration = field.enumerations.find(
            (entry) => writableEnumeration(entry) && entry.name.toLowerCase() === valueText.toLowerCase()
        );
        if (enumeration) {
            if (enumeration.mask !== null)
                throw Object.assign(
                    new Error(`Pattern enumeration cannot be used as an exact write value: ${valueText}`),
                    {
                        code: "INVALID_PERIPHERAL_WRITE_VALUE"
                    }
                );
            value = enumeration.value;
        }
    }
    if (value === undefined) {
        try {
            value = integer(valueText, "peripheral write value", { bigint: true });
        } catch (error) {
            if (error.code !== "INVALID_SVD_VALUE") throw error;
            throw Object.assign(new Error(`Invalid peripheral write value: ${valueText}`), {
                code: "INVALID_PERIPHERAL_WRITE_VALUE",
                details: {
                    value: valueText,
                    ...(field
                        ? {
                              target: field.path,
                              allowedEnumerations: field.enumerations
                                  .filter((entry) => entry.mask === null)
                                  .map((entry) => entry.name)
                          }
                        : {})
                }
            });
        }
    }
    const max = (1n << BigInt(bits)) - 1n;
    if (value < 0n || value > max)
        throw Object.assign(new Error(`Peripheral write value is outside ${bits}-bit range`), {
            code: "INVALID_PERIPHERAL_WRITE_VALUE"
        });
    return value;
}

function jsonConstraint(value) {
    return value?.kind === "range"
        ? { ...value, minimum: value.minimum.toString(), maximum: value.maximum.toString() }
        : value;
}

class SvdPeripheralService {
    constructor(options = {}) {
        this.loadBoundSvd = options.loadBoundSvd;
        this.approve = options.approve;
        this.debugBridge = options.debugBridge;
        this.authorization = options.authorization;
        this.cache = new Map();
        this.parser = options.workerPath
            ? new (require("./svdModelService").SvdModelService)({ workerPath: options.workerPath })
            : null;
    }

    async model() {
        const bound = await this.loadBoundSvd();
        if (!bound?.path)
            throw Object.assign(new Error("No SVD is configured for this workspace"), { code: "SVD_NOT_CONFIGURED" });
        const buffer =
            bound.buffer ||
            (await fs.promises.readFile(bound.path).catch((error) => {
                throw Object.assign(new Error(`Cannot read configured SVD: ${bound.path}`), {
                    code: "SVD_READ_FAILED",
                    details: { cause: error.message }
                });
            }));
        const sha256 = bound.sha256 || crypto.createHash("sha256").update(buffer).digest("hex");
        const key = JSON.stringify([sha256, bound.path]);
        if (!this.cache.has(key))
            this.cache.set(
                key,
                this.parser ? await this.parser.parse(buffer, bound.path, sha256) : parseSvd(buffer, bound.path)
            );
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        return this.cache.get(key);
    }

    dispose() {
        this.parser?.dispose();
        this.cache.clear();
    }

    async list(params = {}) {
        const model = await this.model();
        const query = String(params.query || "")
            .trim()
            .toLowerCase();
        const peripheralFilter = String(params.peripheral || "")
            .trim()
            .toLowerCase();
        const peripherals = model.peripherals
            .map((peripheral) => ({
                ...peripheral,
                registers: peripheral.registers
                    .filter((register) => {
                        if (peripheralFilter && peripheral.name.toLowerCase() !== peripheralFilter) return false;
                        if (!query) return true;
                        return [
                            peripheral.name,
                            register.path,
                            register.description,
                            ...register.fields.map((field) => field.path)
                        ].some((value) =>
                            String(value || "")
                                .toLowerCase()
                                .includes(query)
                        );
                    })
                    .map((register) => ({
                        ...register,
                        writeConstraint: jsonConstraint(register.writeConstraint),
                        resetValue:
                            register.resetValue === undefined ? undefined : hex(register.resetValue, register.size),
                        resetMask:
                            register.resetMask === undefined ? undefined : hex(register.resetMask, register.size),
                        fields: register.fields.map((field) => ({
                            ...field,
                            writeConstraint: jsonConstraint(field.writeConstraint),
                            enumerations: field.enumerations.map((entry) => ({
                                ...entry,
                                value: hex(entry.value, field.bitWidth),
                                mask: entry.mask === null ? undefined : hex(entry.mask, field.bitWidth)
                            }))
                        }))
                    }))
            }))
            .filter((peripheral) => peripheral.registers.length || (!query && !peripheralFilter));
        return { svd: model.svd, peripherals };
    }

    _guard(write = false) {
        this.debugBridge.assertPausedAccess({ write });
        const session = this.debugBridge.activeSession;
        const before = this.debugBridge.agentStatus();
        return () => {
            this.debugBridge.assertPausedAccess({ write });
            const current = this.debugBridge.agentStatus();
            if (
                session !== this.debugBridge.activeSession ||
                before.epoch !== current.epoch ||
                before.session?.id !== current.session?.id
            )
                throw Object.assign(new Error("Peripheral transaction target changed"), {
                    code: "DEBUG_STATE_CHANGED"
                });
        };
    }

    async _readRegister(model, register, guard = this._guard()) {
        guard();
        assertReadable(register);
        const bytes = await this.debugBridge.readPausedMemory(register.address, register.bytes);
        guard();
        if (bytes.length !== register.bytes) throw new Error("Incomplete peripheral register read");
        const value = decodeInteger(bytes, model.svd.endian);
        return {
            path: register.path,
            address: register.addressText,
            size: register.size,
            access: register.access,
            value: hex(value, register.size),
            valueText: value.toString(10),
            fields: register.fields.map((field) => decodedField(value, field)),
            _value: value,
            _bytes: bytes
        };
    }

    async _readRegisters(model, registers, guard = this._guard(), tolerateErrors = false) {
        const ordered = [...new Map(registers.map((register) => [register.path, register])).values()].sort(
            (left, right) => left.address - right.address
        );
        const values = new Map();
        for (const register of ordered) assertReadable(register);
        for (let index = 0; index < ordered.length;) {
            const group = [ordered[index++]];
            while (index < ordered.length) {
                const previous = group[group.length - 1];
                const next = ordered[index];
                const contiguous = next.address === previous.address + previous.bytes;
                const withinLimit = next.address + next.bytes - group[0].address <= 4096;
                if (
                    !contiguous ||
                    !withinLimit ||
                    next.bytes !== previous.bytes ||
                    next.address % next.bytes !== 0 ||
                    next.path.split(".")[0] !== previous.path.split(".")[0]
                )
                    break;
                group.push(next);
                index++;
            }
            guard();
            const expected = group[group.length - 1].address + group[group.length - 1].bytes - group[0].address;
            let bytes;
            try {
                bytes = await this.debugBridge.readPausedMemory(group[0].address, expected);
                guard();
                if (bytes.length !== expected) throw new Error("Incomplete peripheral register read");
            } catch (error) {
                guard();
                if (!tolerateErrors) throw error;
                for (const register of group) {
                    try {
                        if (group.length === 1) throw error;
                        values.set(register.path, await this._readRegister(model, register, guard));
                    } catch (failure) {
                        guard();
                        values.set(register.path, {
                            path: register.path,
                            error: failure.message,
                            code: failure.code || "PERIPHERAL_READ_FAILED"
                        });
                    }
                }
                continue;
            }
            for (const register of group) {
                const offset = register.address - group[0].address;
                const slice = bytes.subarray(offset, offset + register.bytes);
                const value = decodeInteger(slice, model.svd.endian);
                values.set(register.path, {
                    path: register.path,
                    address: register.addressText,
                    size: register.size,
                    access: register.access,
                    value: hex(value, register.size),
                    valueText: value.toString(10),
                    fields: register.fields.map((field) => decodedField(value, field)),
                    _value: value,
                    _bytes: slice
                });
            }
        }
        return values;
    }

    async readForView(targets) {
        const model = await this.model();
        const guard = this._guard();
        const cached = new Map();
        const targetRegisters = new Map();
        const registers = [];
        const errors = new Map();
        const requested = [...new Set(targets)];
        for (const target of requested) {
            guard();
            try {
                const { register, field } = resolveTarget(model, target);
                if (field?.access === "write-only")
                    throw Object.assign(new Error(`Field is write-only: ${field.path}`), {
                        code: "PERIPHERAL_READ_NOT_ALLOWED"
                    });
                assertReadable(register);
                if (!cached.has(register.path)) {
                    cached.set(register.path, register);
                    registers.push(register);
                }
                targetRegisters.set(target, register);
            } catch (error) {
                guard();
                if (
                    [
                        "TARGET_NOT_PAUSED",
                        "DEBUG_STATE_CHANGED",
                        "DEBUG_SESSION_NOT_ACTIVE",
                        "DEBUG_SESSION_CONFLICT"
                    ].includes(error.code)
                )
                    throw error;
                errors.set(target, {
                    path: target,
                    error: error.message,
                    code: error.code || "PERIPHERAL_READ_FAILED"
                });
            }
            guard();
        }
        const values = await this._readRegisters(model, registers, guard, true);
        const output = requested.map((target) => {
            if (errors.has(target)) return errors.get(target);
            const register = targetRegisters.get(target);
            const value = values.get(register.path);
            delete value._value;
            delete value._bytes;
            return value;
        });
        return { session: this.debugBridge.agentStatus(), registers: output };
    }

    async read(params = {}) {
        const model = await this.model();
        const guard = this._guard();
        const resolvedTargets = [];
        const invalidTargets = [];
        for (const target of array(params.targets)) {
            try {
                resolvedTargets.push(resolveTarget(model, target));
            } catch (error) {
                if (error.code !== "SVD_TARGET_NOT_FOUND") throw error;
                invalidTargets.push(String(target || "").trim());
            }
        }
        if (invalidTargets.length)
            throw Object.assign(new Error(`SVD targets were not found: ${invalidTargets.join(", ")}`), {
                code: "SVD_TARGET_NOT_FOUND",
                details: { target: invalidTargets[0], invalidTargets }
            });
        const unique = new Map();
        for (const resolved of resolvedTargets) {
            if (resolved.field?.access === "write-only")
                throw Object.assign(new Error(`Field is write-only: ${resolved.field.path}`), {
                    code: "PERIPHERAL_READ_NOT_ALLOWED"
                });
            unique.set(resolved.register.path, resolved.register);
        }
        if (!unique.size)
            throw Object.assign(new Error("No peripheral targets supplied"), { code: "NO_PERIPHERAL_TARGETS" });
        const values = await this._readRegisters(model, [...unique.values()], guard);
        const registers = [];
        for (const register of unique.values()) {
            const decoded = values.get(register.path);
            delete decoded._value;
            delete decoded._bytes;
            registers.push(decoded);
        }
        return { svd: model.svd, session: this.debugBridge.agentStatus(), registers };
    }

    async _writePlan(model, writes, guard = this._guard(true)) {
        this.debugBridge.assertPausedAccess({ write: true });
        const grouped = new Map();
        const seenTargets = new Set();
        for (const input of array(writes)) {
            const target = String(input?.target || "").trim();
            const resolved = resolveTarget(model, target);
            assertWritable(resolved.register, resolved.field);
            const normalizedTarget = (resolved.field?.path || resolved.register.path).toLowerCase();
            if (seenTargets.has(normalizedTarget))
                throw Object.assign(new Error(`Peripheral target was requested more than once: ${target}`), {
                    code: "DUPLICATE_PERIPHERAL_WRITE"
                });
            seenTargets.add(normalizedTarget);
            const key = resolved.register.path;
            if (!grouped.has(key)) grouped.set(key, { register: resolved.register, changes: [] });
            grouped.get(key).changes.push({ target, field: resolved.field, raw: input?.value });
        }
        if (!grouped.size)
            throw Object.assign(new Error("No peripheral writes supplied"), { code: "NO_PERIPHERAL_WRITES" });
        const items = [];
        for (const { register, changes } of grouped.values()) {
            const snapshot = await this._readRegister(model, register, guard);
            let written = snapshot._value;
            const requested = [];
            for (const change of changes) {
                if (!change.field) {
                    if (changes.length !== 1)
                        throw Object.assign(
                            new Error(`A whole-register write cannot be combined with field writes: ${register.path}`),
                            {
                                code: "DUPLICATE_PERIPHERAL_WRITE"
                            }
                        );
                    written = parseWriteValue(change.raw, null, register.size);
                } else {
                    const value = parseWriteValue(change.raw, change.field, change.field.bitWidth);
                    const shift = BigInt(change.field.bitOffset);
                    const mask = ((1n << BigInt(change.field.bitWidth)) - 1n) << shift;
                    written = (written & ~mask) | (value << shift);
                }
                requested.push({ target: change.target, value: String(change.raw) });
            }
            assertRegisterConstraints(register, written, snapshot._value);
            items.push({
                target: requested.map((entry) => entry.target).join(","),
                register: register.path,
                address: register.addressText,
                addressNumber: register.address,
                size: register.size,
                access: register.access,
                previous: snapshot.value,
                requested,
                written: hex(written, register.size),
                bytes: encodeInteger(written, register.bytes, model.svd.endian)
            });
        }
        return { svd: model.svd, session: this.debugBridge.agentStatus(), items };
    }

    write(params = {}) {
        const pending = (this.writeQueue || Promise.resolve()).then(() => this._write(params));
        this.writeQueue = pending.catch(() => {});
        return pending;
    }

    writeFromUi(params = {}) {
        const pending = (this.writeQueue || Promise.resolve()).then(() => this._write(params, true));
        this.writeQueue = pending.catch(() => {});
        return pending;
    }

    async _write(params, fromUi = false) {
        let model = await this.model();
        const guard = this._guard(true);
        let plan = await this._writePlan(model, params.writes, guard);
        guard();
        if (!fromUi) {
            if (!params.confirmationId) return this.authorization.request(plan);
            if (this.approve) {
                await this.approve("peripherals.write", plan);
                guard();
                model = await this.model();
                guard();
                plan = await this._writePlan(model, params.writes, guard);
                guard();
            }
            this.authorization.authorize(plan, params.confirmationId);
        }
        const results = [];
        let attempted = null;
        try {
            for (const item of plan.items) {
                guard();
                attempted = item.register;
                await this.debugBridge.writePausedMemory(item.addressNumber, item.bytes);
                guard();
                const register = model.registersByPath.get(item.register.toLowerCase());
                const readBack = await this._readRegister(model, register, guard);
                if (readBack.value !== item.written)
                    throw Object.assign(new Error(`Peripheral write read-back mismatch for ${item.register}`), {
                        code: "PERIPHERAL_WRITE_VERIFY_FAILED",
                        details: { expected: item.written, readBack: readBack.value }
                    });
                results.push({
                    target: item.target,
                    register: item.register,
                    address: item.address,
                    previous: item.previous,
                    written: item.written,
                    readBack: readBack.value,
                    verified: true
                });
            }
        } catch (error) {
            error.details = { ...error.details, completed: results, attempted, resultUnknown: attempted !== null };
            error.retryable = false;
            throw error;
        }
        return {
            svd: model.svd,
            session: this.debugBridge.agentStatus(),
            permission: { mode: fromUi ? "direct-ui" : "once" },
            results
        };
    }
}

module.exports = {
    SvdPeripheralService,
    parseSvd,
    resolveTarget,
    decodeInteger,
    encodeInteger,
    fieldValue,
    hex,
    integer,
    assertReadable,
    assertWritable
};
