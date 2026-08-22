"use strict";
const assert = require("assert");
const { buildCsv } = require("../src/liveWatchView");

// RFC 4180:BOM 头、保留字符转义、CRLF 行尾;宽表按采样时间戳对齐,晚加入的序列起始前留空单元格
const t0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const csv = buildCsv(["counter", 'weird,"name"'], [
    [{ t: t0, v: 1 }, { t: t0 + 100, v: 2 }],
    [{ t: t0 + 100, v: -0.5 }]
]);
const lines = csv.split("\r\n");
assert.strictEqual(lines[0], "\uFEFFtime,counter,\"weird,\"\"name\"\"\"", "header should keep the BOM and quote reserved characters");
assert.strictEqual(lines[1], "2026-01-02T03:04:05.678Z,1,", "series joined later should leave cells empty before its first sample");
assert.strictEqual(lines[2], "2026-01-02T03:04:05.778Z,2,-0.5", "rows should align samples by timestamp");
assert.ok(csv.endsWith("\r\n"), "file should end with CRLF");
assert.strictEqual(buildCsv(["a"], [[]]), "\uFEFFtime,a\r\n", "empty buffers should produce only the header");

console.log("CSV export tests passed");
