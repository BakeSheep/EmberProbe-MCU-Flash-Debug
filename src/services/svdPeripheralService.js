"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { XMLParser, XMLValidator } = require("fast-xml-parser");

const SUPPORTED_SIZES = new Set([8, 16, 32, 64]);
const NORMAL_WRITE_ACCESS = "read-write";

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
        modifiedWriteValues: text(node?.modifiedWriteValues) || parent.modifiedWriteValues
    };
}

function merge(base, override) {
    if (!base || typeof base !== "object") return override;
    if (!override || typeof override !== "object") return override === undefined ? base : override;
    if (Array.isArray(base) || Array.isArray(override)) return override;
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
    return result;
}

function resolveDerived(items, kind) {
    const byName = new Map(items.map((item) => [text(item?.name), item]));
    const cache = new Map();
    const resolving = new Set();
    const resolve = (item) => {
        if (cache.has(item)) return cache.get(item);
        if (resolving.size >= 128 || resolving.has(item))
            throw Object.assign(new Error(`Cyclic ${kind} derivedFrom chain`), { code: "INVALID_SVD_DERIVATION" });
        resolving.add(item);
        const reference = text(item?.["@_derivedFrom"]);
        let result = item;
        if (reference) {
            const shortName = reference.split(".").pop();
            const base = byName.get(reference) || byName.get(shortName);
            if (!base)
                throw Object.assign(new Error(`Unknown ${kind} derivedFrom target: ${reference}`), {
                    code: "INVALID_SVD_DERIVATION"
                });
            result = merge(resolve(base), item);
        }
        resolving.delete(item);
        cache.set(item, result);
        return result;
    };
    return items.map(resolve);
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

function enumerations(node) {
    const result = [];
    for (const group of array(node?.enumeratedValues)) {
        const usage = text(group?.usage) || "read-write";
        for (const entry of array(group?.enumeratedValue)) {
            if (!text(entry?.name) || entry?.value === undefined) continue;
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
    return result;
}

function enumerationValue(rawValue) {
    const raw = text(rawValue).replace(/_/g, "");
    const binary = raw.match(/^(?:#|0b)([01x]+)$/i);
    if (!binary) {
        const value = integer(raw, "enumerated value", { bigint: true });
        return { value, mask: null };
    }
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
    const raw = resolveDerived(array(registerNode?.fields?.field), "field");
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
                enumerations: enumerations(node)
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
        fields: []
    };
    register.fields = normalizeFields(node, register, properties, budget);
    return register;
}

function normalizeRegisterGroup(group, peripheral, prefix, baseOffset, defaults, budget, depth = 0) {
    if (depth > 32) throw Object.assign(new Error("SVD nesting budget exceeded"), { code: "SVD_BUDGET_EXCEEDED" });
    consumeBudget(budget);
    const output = [];
    const registers = resolveDerived(array(group?.register), "register");
    for (const registerNode of registers) {
        for (const item of expandDim(registerNode))
            output.push(
                normalizeRegister(item.node, peripheral, prefix, baseOffset, defaults, item.index, item.offset, budget)
            );
    }
    const clusters = resolveDerived(array(group?.cluster), "cluster");
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
    const deviceNode = parsed?.device;
    if (!deviceNode) throw Object.assign(new Error("SVD device element is missing"), { code: "INVALID_SVD_STRUCTURE" });
    const endian = text(deviceNode?.cpu?.endian) || "little";
    if (!new Set(["little", "big"]).has(endian))
        throw Object.assign(new Error(`Unsupported or ambiguous SVD endian: ${endian}`), {
            code: "UNSUPPORTED_SVD_ENDIAN"
        });
    const budget = { remaining: 100000 };
    const defaults = inherit({ size: 32, access: "read-write" }, deviceNode);
    const peripheralNodes = resolveDerived(array(deviceNode?.peripherals?.peripheral), "peripheral");
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
    const enumeration = field.enumerations.find((entry) =>
        entry.mask === null ? entry.value === value : (value & entry.mask) === entry.value
    );
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
        const enumeration = field.enumerations.find((entry) => entry.name.toLowerCase() === valueText.toLowerCase());
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

class SvdPeripheralService {
    constructor(options = {}) {
        this.loadBoundSvd = options.loadBoundSvd;
        this.debugBridge = options.debugBridge;
        this.authorization = options.authorization;
        this.cache = new Map();
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
        if (!this.cache.has(sha256)) this.cache.set(sha256, parseSvd(buffer, bound.path));
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        return this.cache.get(sha256);
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
                        resetValue:
                            register.resetValue === undefined ? undefined : hex(register.resetValue, register.size),
                        resetMask:
                            register.resetMask === undefined ? undefined : hex(register.resetMask, register.size),
                        fields: register.fields.map((field) => ({
                            ...field,
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
        const registers = [];
        for (const register of unique.values()) {
            const decoded = await this._readRegister(model, register, guard);
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

    async _write(params) {
        const model = await this.model();
        const guard = this._guard(true);
        const plan = await this._writePlan(model, params.writes, guard);
        guard();
        if (!params.confirmationId) return this.authorization.request(plan);
        this.authorization.authorize(plan, params.confirmationId);
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
        return { svd: model.svd, session: this.debugBridge.agentStatus(), permission: { mode: "once" }, results };
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
