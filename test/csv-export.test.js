"use strict";
const assert = require("assert");
const { buildCsv, csvDataRowCount } = require("../src/liveWatchView");

// RFC 4180:BOM 头、保留字符转义、CRLF 行尾;宽表按采样时间戳对齐,晚加入的序列起始前留空单元格
const t0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const csv = buildCsv(
    ["counter", 'weird,"name"'],
    [
        [
            { t: t0, v: 1 },
            { t: t0 + 100, v: 2 }
        ],
        [{ t: t0 + 100, v: -0.5 }]
    ]
);
const lines = csv.split("\r\n");
assert.strictEqual(
    lines[0],
    '\uFEFFtime,counter,"weird,""name"""',
    "header should keep the BOM and quote reserved characters"
);
assert.strictEqual(
    lines[1],
    "2026-01-02T03:04:05.678Z,1,",
    "series joined later should leave cells empty before its first sample"
);
assert.strictEqual(lines[2], "2026-01-02T03:04:05.778Z,2,-0.5", "rows should align samples by timestamp");
assert.ok(csv.endsWith("\r\n"), "file should end with CRLF");
assert.strictEqual(buildCsv(["a"], [[]]), "\uFEFFtime,a\r\n", "empty buffers should produce only the header");

const ranged = buildCsv(
    ["wide", "state"],
    [
        [
            { t: t0, v: Number(18446744073709551615n), valueText: "18446744073709551615" },
            { t: t0 + 1000, v: NaN, valueText: "NaN" }
        ],
        [
            { t: t0 + 500, v: 7 },
            { t: t0 + 1000, v: Infinity, valueText: "Infinity" }
        ]
    ],
    { from: t0 + 500, to: t0 + 1000 }
);
const rangedLines = ranged.split("\r\n");
assert.strictEqual(rangedLines[1], "2026-01-02T03:04:06.178Z,,7", "from endpoint should be included");
assert.strictEqual(
    rangedLines[2],
    "2026-01-02T03:04:06.678Z,NaN,Infinity",
    "to endpoint and exact text should be included"
);
assert.strictEqual(
    buildCsv(["wide"], [[{ t: t0, v: 1, valueText: "18446744073709551615" }]]).split("\r\n")[1],
    "2026-01-02T03:04:05.678Z,18446744073709551615",
    "valueText should take precedence over approximate values"
);
assert.strictEqual(
    buildCsv(["a"], [[{ t: t0, v: 1 }]], { from: t0 + 1, to: t0 + 2 }),
    "\uFEFFtime,a\r\n",
    "empty ranges should contain only the header"
);
assert.strictEqual(
    buildCsv(['=HYPERLINK("https://example.invalid")'], [[]]).split("\r\n")[0],
    '\uFEFFtime,"\'=HYPERLINK(""https://example.invalid"")"',
    "ELF-controlled series names must not become spreadsheet formulas"
);

assert.strictEqual(
    buildCsv(["failed"], [[{ t: t0, v: null, valueText: "-" }]]).split("\r\n")[1],
    "2026-01-02T03:04:05.678Z,",
    "failed readings must leave CSV cells empty"
);
assert.strictEqual(csvDataRowCount(buildCsv(["line\r\nbreak"], [[{ t: t0, v: 1 }]])), 1);
assert.strictEqual(csvDataRowCount(buildCsv(["empty"], [[]])), 0);

console.log("CSV export tests passed");
