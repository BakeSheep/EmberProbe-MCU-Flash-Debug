"use strict";
function minimalElf(payload = "firmware") {
    const header = Buffer.alloc(52);
    header.writeUInt32BE(0x7f454c46, 0);
    header[4] = header[5] = header[6] = 1;
    header.writeUInt16LE(0x28, 18);
    header.writeUInt32LE(1, 20);
    header.writeUInt16LE(52, 40);
    return Buffer.concat([header, Buffer.from(payload)]);
}
module.exports = { minimalElf };
