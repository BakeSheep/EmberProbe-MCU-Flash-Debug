"use strict";
const { readULEB, readSLEB, readAddr, cstr } = require("./binary");
function createFormReader({ buf, str, lineStr }) {
    let depth = 0;
    return function readForm(cur, form, ctx) {
        if (++depth > 32) {
            depth--;
            throw new Error("DWARF indirect form nesting exceeded");
        }
        try {
            if (!Number.isSafeInteger(cur.p) || cur.p < 0 || cur.p > buf.length)
                throw new Error("Invalid DWARF cursor");
            const result = readValue(cur, form, ctx);
            if (!Number.isSafeInteger(cur.p) || cur.p > buf.length) throw new Error("Truncated DWARF attribute");
            return result;
        } finally {
            depth--;
        }
        function readValue(cur, form, ctx) {
            switch (form) {
                case 0x01:
                    return readAddr(buf, cur, ctx.addrSize); // addr
                case 0x03: {
                    const n = buf.readUInt16LE(cur.p);
                    cur.p += 2;
                    const b = buf.subarray(cur.p, cur.p + n);
                    cur.p += n;
                    return { block: b };
                }
                case 0x04: {
                    const n = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    const b = buf.subarray(cur.p, cur.p + n);
                    cur.p += n;
                    return { block: b };
                }
                case 0x05: {
                    const v = buf.readUInt16LE(cur.p);
                    cur.p += 2;
                    return v;
                }
                case 0x06: {
                    const v = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return v;
                }
                case 0x07: {
                    cur.p += 8;
                    return 0;
                } // data8
                case 0x08: {
                    const end = buf.indexOf(0, cur.p);
                    if (end < 0) throw new Error("Unterminated DWARF string");
                    const stringEnd = end;
                    const s = buf.toString("utf8", cur.p, stringEnd);
                    cur.p = end < 0 ? buf.length : end + 1;
                    return { str: s };
                }
                case 0x09: {
                    const n = readULEB(buf, cur);
                    const b = buf.subarray(cur.p, cur.p + n);
                    cur.p += n;
                    return { block: b };
                }
                case 0x0a: {
                    const n = buf[cur.p];
                    cur.p += 1;
                    const b = buf.subarray(cur.p, cur.p + n);
                    cur.p += n;
                    return { block: b };
                }
                case 0x0b: {
                    const v = buf[cur.p];
                    cur.p += 1;
                    return v;
                }
                case 0x0c: {
                    const v = buf[cur.p];
                    cur.p += 1;
                    return v !== 0;
                }
                case 0x0d:
                    return readSLEB(buf, cur);
                case 0x0e: {
                    const off = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return { str: str ? cstr(str.data, off) : "" };
                }
                case 0x0f:
                    return readULEB(buf, cur);
                case 0x10: {
                    const off = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return { ref: off };
                } // ref_addr（节内偏移）
                case 0x11: {
                    const v = buf[cur.p];
                    cur.p += 1;
                    return { ref: ctx.cuRel + v };
                }
                case 0x12: {
                    const v = buf.readUInt16LE(cur.p);
                    cur.p += 2;
                    return { ref: ctx.cuRel + v };
                }
                case 0x13: {
                    const v = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return { ref: ctx.cuRel + v };
                }
                case 0x14: {
                    const lo = buf.readUInt32LE(cur.p);
                    cur.p += 8;
                    return { ref: ctx.cuRel + lo };
                }
                case 0x15: {
                    const v = readULEB(buf, cur);
                    return { ref: ctx.cuRel + v };
                }
                case 0x16: {
                    const f = readULEB(buf, cur);
                    return readForm(cur, f, ctx);
                } // indirect
                case 0x17: {
                    const v = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return v;
                } // sec_offset
                case 0x18: {
                    const n = readULEB(buf, cur);
                    const b = buf.subarray(cur.p, cur.p + n);
                    cur.p += n;
                    return { block: b };
                }
                case 0x19:
                    return true; // flag_present
                case 0x1a:
                    return { strx: readULEB(buf, cur) };
                case 0x1b: {
                    readULEB(buf, cur);
                    return 0;
                } // addrx
                case 0x1c: {
                    cur.p += 4;
                    return 0;
                }
                case 0x1d: {
                    cur.p += 4;
                    return { str: "" };
                }
                case 0x1e: {
                    const b = buf.subarray(cur.p, cur.p + 16);
                    cur.p += 16;
                    return { block: b };
                }
                case 0x1f: {
                    const off = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return { str: lineStr ? cstr(lineStr.data, off) : "" };
                }
                case 0x20: {
                    cur.p += 8;
                    return 0;
                }
                case 0x21:
                    return ctx.implicit !== undefined ? ctx.implicit : 0; // implicit_const
                case 0x22: {
                    readULEB(buf, cur);
                    return 0;
                }
                case 0x23: {
                    readULEB(buf, cur);
                    return 0;
                }
                case 0x24: {
                    cur.p += 8;
                    return 0;
                }
                case 0x25: {
                    const v = buf[cur.p];
                    cur.p += 1;
                    return { strx: v };
                }
                case 0x26: {
                    const v = buf.readUInt16LE(cur.p);
                    cur.p += 2;
                    return { strx: v };
                }
                case 0x27: {
                    const v = buf.readUIntLE(cur.p, 3);
                    cur.p += 3;
                    return { strx: v };
                }
                case 0x28: {
                    const v = buf.readUInt32LE(cur.p);
                    cur.p += 4;
                    return { strx: v };
                }
                case 0x29: {
                    cur.p += 1;
                    return 0;
                }
                case 0x2a: {
                    cur.p += 2;
                    return 0;
                }
                case 0x2b: {
                    cur.p += 3;
                    return 0;
                }
                case 0x2c: {
                    cur.p += 4;
                    return 0;
                }
                // GNU split-dwarf 扩展 form：按已知长度推进游标即可，值本身不可用
                // （split-dwarf 的完整信息在 .dwo 文件中，本解析器不消费）。
                // 若在此抛错会中止整个 CU，导致后续所有变量丢失 DWARF 布局。
                case 0x1f01:
                    return readULEB(buf, cur); // GNU_addr_index
                case 0x1f02:
                    return readULEB(buf, cur); // GNU_str_index
                case 0x1f03: {
                    cur.p += 4;
                    return { ref: 0 };
                } // GNU_ref_alt
                case 0x1f04: {
                    cur.p += 4;
                    return { str: "" };
                } // GNU_strp_alt
                default:
                    throw new Error("unknown DWARF form 0x" + form.toString(16));
            }
        }
    };
}
module.exports = { createFormReader };
