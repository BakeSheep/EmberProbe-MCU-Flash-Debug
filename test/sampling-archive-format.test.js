"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
    ArchiveEncoder,
    FILE_HEADER,
    decodeRecords,
    scanRecords,
    readArchive
} = require("../src/services/samplingArchiveFormat");

function scanned(buffer, offset = 0, dictionary, lastValueOnly = false) {
    let state = dictionary;
    const rows = [];
    const result = scanRecords(buffer, offset, dictionary, {
        lastValueOnly,
        definition: (type, id, next) => {
            state = next;
        },
        row: (at, end, scopeId, generation, t) => {
            rows.push({ t, v: {}, scope: state.scopes[scopeId], generation, identities: {}, offset: at, end });
        },
        value: (id, kind, number, text) => {
            const row = rows.at(-1),
                channel = state.channels[id];
            Object.defineProperty(row.v, channel.key, {
                value: kind === 0 ? null : kind === 4 ? text : String(number),
                enumerable: true,
                configurable: true
            });
            if (channel.identity)
                Object.defineProperty(row.identities, channel.key, {
                    value: channel.identity,
                    enumerable: true,
                    configurable: true
                });
            else delete row.identities[channel.key];
        }
    });
    for (const row of rows) if (!Object.keys(row.identities).length) row.identities = undefined;
    const sink = { offsets: [], count: 0 };
    assert.deepStrictEqual(scanRecords(buffer, offset, dictionary, sink), result);
    assert.deepStrictEqual(
        sink.offsets,
        rows.map((row) => row.offset)
    );
    assert.strictEqual(sink.count, rows.length);
    if (sink.layout) {
        for (const row of rows) {
            assert.strictEqual(row.end - row.offset, sink.layout.bytes);
            const ids = [],
                positions = [];
            let cursor = row.offset + 21;
            for (let i = 0; i < buffer.readUInt16LE(row.offset + 19); i++) {
                ids.push(buffer.readUInt16LE(cursor));
                positions.push(cursor - row.offset);
                const kind = buffer[cursor + 2];
                cursor += 3;
                cursor += kind === 0 ? 0 : kind === 4 ? 4 + buffer.readUInt32LE(cursor) : kind === 3 ? 8 : 4;
            }
            assert.deepStrictEqual(ids, sink.layout.ids);
            assert.deepStrictEqual(positions, sink.layout.positions);
        }
    }
    return { rows, ...result };
}

function record(type, payload) {
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

async function collect(file, options) {
    const iterator = readArchive(file, options);
    const rows = [];
    while (true) {
        const next = await iterator.next();
        if (next.done) return { rows, ...next.value };
        rows.push(next.value);
    }
}

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-format-"));
    const file = path.join(dir, "samples.bin");
    try {
        assert.strictEqual(FILE_HEADER.toString("ascii", 0, 4), "EPSA");
        assert.strictEqual(FILE_HEADER.readUInt16LE(4), 1);
        assert.deepStrictEqual(FILE_HEADER.subarray(6), Buffer.alloc(10));
        const encoder = new ArchiveEncoder();
        const texts = [
            null,
            "-2147483648",
            "2147483647",
            "1.5",
            "0.1",
            "-0",
            "NaN",
            "Infinity",
            "-Infinity",
            "18446744073709551615",
            "-9223372036854775808",
            "Ready",
            "",
            "01",
            "1.0",
            "1e3",
            " 1",
            "中🙂",
            "\uFEFFvalue",
            "x".repeat(1024 * 1024)
        ];
        const first = encoder.encodeRow({
            t: 100,
            scope: "scope🙂",
            values: texts.map((text, i) => ({
                key: `v${i} [f32]`,
                text,
                identity: i === 0 ? undefined : "address-1"
            }))
        });
        const snapshot = encoder.dictionary();
        const second = encoder.encodeRow({
            t: 90,
            scope: "other",
            generation: 7,
            values: [{ key: "v1 [f32]", text: "42", identity: "address-2" }]
        });
        const third = encoder.encodeRow({
            t: 105,
            scope: "scope🙂",
            generation: 2,
            values: [
                { key: "__proto__", text: "safe", identity: "constructor" },
                { key: "v1 [f32]", text: null }
            ]
        });
        const binary = Buffer.concat([FILE_HEADER, first, second, third]);
        const decoded = decodeRecords(binary);
        assert.deepStrictEqual(scanned(binary), decoded);
        assert.deepStrictEqual(scanned(binary, 0, undefined, true), decoded);
        assert.strictEqual(decoded.end, binary.length);
        assert.deepStrictEqual(Object.values(decoded.rows[0].v), texts);
        assert.deepStrictEqual(
            decoded.rows.map(({ t, scope, generation }) => [t, scope, generation]),
            [
                [100, "scope🙂", 0],
                [90, "other", 7],
                [105, "scope🙂", 2]
            ]
        );
        assert.strictEqual(decoded.rows[0].identities["v1 [f32]"], "address-1");
        assert.strictEqual(decoded.rows[1].identities["v1 [f32]"], "address-2");
        assert.strictEqual(decoded.rows[2].identities.__proto__, "constructor");
        assert.strictEqual(decoded.rows[2].v.__proto__, "safe");
        assert.strictEqual(Object.getPrototypeOf(decoded.rows[2].v), Object.prototype);
        assert.strictEqual(snapshot.scopes.length, 1, "snapshots do not change when the encoder extends dictionaries");
        assert.strictEqual(snapshot.channels.length, texts.length);

        // Check actual wire kinds, rather than allowing an all-text implementation to pass round-trip tests.
        const row = decoded.rows[0];
        let cursor = row.offset + 21;
        const kinds = [];
        for (let i = 0; i < texts.length; i++) {
            const kind = binary[cursor + 2];
            kinds.push(kind);
            cursor += 3;
            if (kind === 4) cursor += 4 + binary.readUInt32LE(cursor);
            else cursor += kind === 0 ? 0 : kind === 3 ? 8 : 4;
        }
        assert.deepStrictEqual(kinds, [0, 1, 1, 2, 3, 4, 3, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
        assert.strictEqual(cursor, row.end);
        const start = 16 + first.length;
        assert.deepStrictEqual(decodeRecords(binary, start, snapshot).rows, decoded.rows.slice(1));
        assert.deepStrictEqual(scanned(binary, start, snapshot), decodeRecords(binary, start, snapshot));
        assert.deepStrictEqual(scanned(binary, 0, encoder.dictionary()), decoded);
        assert.deepStrictEqual(snapshot, { scopes: ["scope🙂"], channels: snapshot.channels });
        await fs.writeFile(file, binary);
        assert.deepStrictEqual((await collect(file)).rows, decoded.rows);
        assert.deepStrictEqual((await collect(file, { start, dictionary: snapshot })).rows, decoded.rows.slice(1));
        assert.deepStrictEqual((await collect(file, { end: start })).rows, decoded.rows.slice(0, 1));
        // Full snapshots must also work at an earlier boundary and while re-reading definitions.
        assert.deepStrictEqual((await collect(file, { dictionary: encoder.dictionary() })).rows, decoded.rows);

        const last = decoded.rows.at(-1);
        for (let end = last.offset; end < last.end; end++) {
            const truncated = binary.subarray(0, end);
            const result = decodeRecords(truncated);
            assert.deepStrictEqual(scanned(truncated), result);
            assert.strictEqual(result.end, last.offset, `valid end for truncation at ${end}`);
            assert.deepStrictEqual(result.rows, decoded.rows.slice(0, -1));
            await fs.writeFile(file, truncated);
            const streamed = await collect(file);
            assert.strictEqual(streamed.end, last.offset);
            assert.deepStrictEqual(streamed.rows, result.rows);
        }
        const smallEncoder = new ArchiveEncoder();
        const small = Buffer.concat([FILE_HEADER, smallEncoder.encodeRow({ t: 1, values: [{ key: "x", text: "3" }] })]);
        const smallRow = decodeRecords(small).rows[0];
        // Every header/definition truncation also stops at the preceding complete boundary.
        for (let end = 0; end < small.length; end++) {
            assert.deepStrictEqual(scanned(small.subarray(0, end)), decodeRecords(small.subarray(0, end)));
            await fs.writeFile(file, small.subarray(0, end));
            assert.strictEqual((await collect(file)).end, decodeRecords(small.subarray(0, end)).end);
        }
        const invalid = [];
        const corruptLength = Buffer.from(small);
        corruptLength.writeUInt32LE(0xffffffff, smallRow.offset + 1);
        invalid.push(corruptLength);
        const badKind = Buffer.from(small);
        badKind[smallRow.offset + 23] = 5;
        invalid.push(badKind);
        const badScope = Buffer.from(small);
        badScope.writeUInt16LE(50, smallRow.offset + 5);
        invalid.push(badScope);
        const badChannel = Buffer.from(small);
        badChannel.writeUInt16LE(50, smallRow.offset + 21);
        invalid.push(badChannel);
        const badTime = Buffer.from(small);
        badTime.writeDoubleLE(Infinity, smallRow.offset + 11);
        invalid.push(badTime);
        const extra = Buffer.concat([small, Buffer.from([0])]);
        extra.writeUInt32LE(small.readUInt32LE(smallRow.offset + 1) + 1, smallRow.offset + 1);
        invalid.push(extra);
        for (const bad of invalid) {
            const result = decodeRecords(bad);
            assert.strictEqual(result.end, smallRow.offset);
            assert.deepStrictEqual(result.rows, []);
            await fs.writeFile(file, bad);
            assert.strictEqual((await collect(file)).end, result.end);
        }
        for (const payload of [
            Buffer.alloc(0),
            Buffer.from([2, 0, 0, 0, 0, 0]),
            Buffer.from([0, 0, 1, 0, 0, 0, 0xff]),
            Buffer.from([0, 0, 255, 255, 255, 255])
        ]) {
            const bad = Buffer.concat([small, record(1, payload), small.subarray(smallRow.offset)]);
            assert.strictEqual(decodeRecords(bad).end, small.length);
            await fs.writeFile(file, bad);
            assert.strictEqual((await collect(file)).end, small.length);
        }
        const conflicting = new ArchiveEncoder().encodeRow({ t: 2, scope: "changed", values: [] });
        assert.deepStrictEqual(
            scanned(Buffer.concat([small, conflicting])),
            decodeRecords(Buffer.concat([small, conflicting]))
        );
        assert.strictEqual(decodeRecords(Buffer.concat([small, conflicting])).end, small.length);
        const invalidText = new ArchiveEncoder();
        const badUtf8 = Buffer.concat([
            FILE_HEADER,
            invalidText.encodeRow({ t: 2, values: [{ key: "x", text: "a" }] })
        ]);
        badUtf8[badUtf8.length - 1] = 0xff;
        assert.strictEqual(decodeRecords(badUtf8).rows.length, 0);
        assert.deepStrictEqual(scanned(badUtf8), decodeRecords(badUtf8));
        const unknown = record(200, Buffer.alloc(300000, 5));
        const extended = Buffer.concat([small, unknown, small.subarray(smallRow.offset)]);
        assert.strictEqual(decodeRecords(extended).rows.length, 2);
        assert.deepStrictEqual(scanned(extended), decodeRecords(extended));
        await fs.writeFile(file, extended);
        assert.deepStrictEqual((await collect(file)).rows, decodeRecords(extended).rows);
        for (const byte of [0, 4, 6, 15]) {
            const badHeader = Buffer.from(small);
            badHeader[byte] ^= 1;
            assert.strictEqual(decodeRecords(badHeader).end, 0);
            await fs.writeFile(file, badHeader);
            assert.strictEqual((await collect(file)).end, 0);
        }
        assert.strictEqual(decodeRecords(small, -1).rows.length, 0);
        assert.strictEqual(decodeRecords(small, 0, { scopes: [1] }).end, 0);
        assert.strictEqual(decodeRecords(small, 0, { scopes: Array(1) }).end, 0);
        assert.strictEqual(decodeRecords(small, 0, { channels: [null] }).end, 0);
        for (const dictionary of [{ scopes: [1] }, { scopes: Array(1) }, { channels: [null] }])
            assert.deepStrictEqual(scanned(small, 0, dictionary), decodeRecords(small, 0, dictionary));
        for (const offset of [-1, 0.5, small.length + 1])
            assert.deepStrictEqual(scanned(small, offset), decodeRecords(small, offset));
        for (const bad of invalid) assert.deepStrictEqual(scanned(bad), decodeRecords(bad));
        for (let i = 0; i < small.length; i++) {
            const bad = Buffer.from(small);
            bad[i] ^= 0xff;
            assert.deepStrictEqual(scanned(bad), decodeRecords(bad), `scanner mutation ${i}`);
        }
        const duplicateEncoder = new ArchiveEncoder();
        const duplicates = Buffer.concat([
            FILE_HEADER,
            duplicateEncoder.encodeRow({
                t: 1,
                values: [
                    { key: "__proto__", text: "1", identity: "old" },
                    { key: "__proto__", text: "2" },
                    { key: "x", text: "3" },
                    { key: "x", text: "4", identity: "new" }
                ]
            })
        ]);
        assert.deepStrictEqual(scanned(duplicates), decodeRecords(duplicates));
        assert.deepStrictEqual(scanned(duplicates, 0, undefined, true), decodeRecords(duplicates));
        let calls = 0;
        assert.strictEqual(
            scanRecords(small, 0, undefined, {
                row: () => false,
                value: () => calls++
            }).end,
            small.length
        );
        assert.strictEqual(calls, 0);
        scanRecords(small, 0, undefined, { select: () => false, value: () => calls++ });
        assert.strictEqual(calls, 0);
        assert.strictEqual(scanRecords(small).end, small.length);
        const layoutEncoder = new ArchiveEncoder(),
            layoutRecords = [FILE_HEADER];
        for (let i = 0; i < 16; i++)
            layoutRecords.push(
                layoutEncoder.encodeRow({
                    t: i,
                    values: [
                        { key: "x", text: i % 2 ? "1.5" : "2" },
                        { key: "y", text: i % 2 ? "3" : "2.5" }
                    ]
                })
            );
        const uniform = Buffer.concat(layoutRecords),
            sink = { offsets: new Uint32Array(16), count: 0, layout: null };
        assert.deepStrictEqual(scanned(uniform), decodeRecords(uniform));
        scanRecords(uniform, 0, undefined, sink);
        assert.strictEqual(sink.count, 16);
        assert.deepStrictEqual(sink.layout.positions, [21, 28], "int/f32 kind changes can share validated offsets");
        for (const values of [
            [
                { key: "y", text: "1" },
                { key: "x", text: "2" }
            ],
            [{ key: "x", text: "1" }],
            [
                { key: "x", text: "0.1" },
                { key: "y", text: null }
            ],
            [
                { key: "x", text: "0.1" },
                { key: "y", text: "1" }
            ]
        ]) {
            const changed = Buffer.concat([uniform, layoutEncoder.encodeRow({ t: 17, values })]);
            const sink = { offsets: [], count: 0, layout: null };
            scanRecords(changed, 0, undefined, sink);
            assert.strictEqual(sink.layout, null, "changed IDs, counts, positions or record sizes reject the layout");
            assert.deepStrictEqual(scanned(changed), decodeRecords(changed));
        }
        assert.throws(
            () =>
                scanRecords(small, 0, undefined, {
                    row: () => {
                        throw new Error("visitor failed");
                    }
                }),
            /visitor failed/
        );
        assert.deepStrictEqual((await collect(file, { start: -1 })).rows, []);
        assert.deepStrictEqual((await collect(file, { start: 999999 })).rows, []);
        await assert.rejects(collect(path.join(dir, "missing")), { code: "ENOENT" });

        const badEncoder = new ArchiveEncoder();
        for (const row of [
            { t: NaN, values: [] },
            { t: 1, generation: -1, values: [] },
            { t: 1, values: [{ key: 2, text: "1" }] },
            { t: 1, values: [{ key: "x", text: undefined }] }
        ])
            assert.throws(() => badEncoder.encodeRow(row), TypeError);
        assert.deepStrictEqual(badEncoder.dictionary(), { scopes: [], channels: [] });
        const full = new ArchiveEncoder();
        const values = Array.from({ length: 65535 }, (_, i) => ({ key: String(i), text: null }));
        full.encodeRow({ t: 1, values });
        assert.throws(() => full.encodeRow({ t: 2, values: [{ key: "overflow", text: null }] }), {
            code: "SAMPLING_ARCHIVE_DICTIONARY_FULL"
        });
        assert.throws(() => full.encodeRow({ t: 2, values: [...values, values[0]] }), {
            code: "SAMPLING_ARCHIVE_DICTIONARY_FULL"
        });
        const scopes = new ArchiveEncoder();
        for (let i = 0; i < 65535; i++) scopes.encodeRow({ t: i, scope: String(i), values: [] });
        assert.throws(() => scopes.encodeRow({ t: 1, scope: "overflow", values: [] }), {
            code: "SAMPLING_ARCHIVE_DICTIONARY_FULL"
        });
        console.log("Binary archive kinds, dictionaries, seek, streaming, corrupt tails and limits passed");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
