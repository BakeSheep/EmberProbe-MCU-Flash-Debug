"use strict";
const { ElfService } = require("../../src/services/elfService");
const elf = require("../../src/elfSymbols");
const handle = (id = "MQ") => "layout:" + "a".repeat(32) + ":" + id + ":" + "b".repeat(64);
const scalar = (name, offset = 0) => ({ name, offset, byteSize: 4, kind: "scalar", watchType: "f32" });
function fixture() {
    const generation = 7;
    const limited = (name, offset, byteSize, id) => ({
        name,
        offset,
        byteSize,
        kind: "class",
        typeName: "Deep",
        unobservable: "depth-limit",
        expansionHandle: handle(id)
    });
    const branch = limited("b", 20, 32, "MQ");
    const layout = {
        kind: "array",
        byteSize: 256,
        totalElements: 2,
        dimensions: [2],
        expansionGeneration: generation,
        elementType: {
            kind: "class",
            byteSize: 128,
            compositeLayout: {
                kind: "class",
                byteSize: 128,
                members: [
                    {
                        name: "",
                        offset: 12,
                        byteSize: 112,
                        compositeLayout: {
                            kind: "class",
                            byteSize: 112,
                            members: [
                                {
                                    name: "a",
                                    offset: 16,
                                    byteSize: 80,
                                    compositeLayout: {
                                        kind: "class",
                                        byteSize: 80,
                                        members: [branch]
                                    }
                                }
                            ]
                        }
                    }
                ]
            }
        }
    };
    const sublayout = {
        kind: "class",
        typeName: "Deep",
        byteSize: 32,
        expansionGeneration: generation,
        truncated: true,
        members: [
            scalar("gain", 4),
            limited("c", 8, 16, "Mg"),
            { name: "cycle", offset: 28, byteSize: 0, unobservable: "type-cycle", kind: "class" }
        ]
    };
    const nested = {
        kind: "class",
        byteSize: 16,
        expansionGeneration: generation,
        members: [
            {
                name: "@base0",
                offset: 4,
                byteSize: 12,
                compositeLayout: {
                    kind: "class",
                    byteSize: 12,
                    members: [scalar("gain", 4)]
                }
            }
        ]
    };
    const symbol = { name: "axes", address: 0x20000100, size: 256, isComposite: true, compositeLayout: layout };
    const service = new ElfService({ t: (key) => key, elfSymbols: elf });
    service.generation = generation;
    service.cache = { elf: { sha256: "v1" }, symbols: [symbol], warnings: [], dwarfReady: true };
    service.symbolByName.set(symbol.name, symbol);
    service.ready = async () => service.cache;
    service.layout = async (name) => service.symbolByName.get(name)?.compositeLayout;
    service.read = () => service.cache;
    service.expandLayout = async (token) => (token === handle("Mg") ? nested : sublayout);
    return { service, symbol, layout, branch, sublayout, nested, generation };
}
function runtimeGraph() {
    return {
        root: 4,
        types: [
            { kind: "scalar", watchType: "f32", byteSize: 4 },
            { kind: "class", fields: [{ name: "a", type: 2, offset: 28 }] },
            { kind: "class", fields: [{ name: "b", type: 3, offset: 20 }] },
            { kind: "class", stl: "variant", args: [0], byteSize: 32 },
            { kind: "array", target: 1, count: 2, byteSize: 256 }
        ]
    };
}
module.exports = { fixture, handle, scalar, runtimeGraph };
