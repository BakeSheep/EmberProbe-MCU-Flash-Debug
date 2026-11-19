"use strict";

const fs = require("node:fs/promises");
const { ArchiveEncoder, FILE_HEADER, readArchive } = require("./samplingArchiveFormat");

const INDEX_BLOCK_BYTES = 64 * 1024;
const WRITE_BATCH_BYTES = 1024 * 1024;

function indexSampleTime(index, offset, t) {
    let block = index.at(-1);
    if (!block || offset - block.offset >= INDEX_BLOCK_BYTES) index.push((block = { offset, tMin: t, tMax: t }));
    block.tMin = Math.min(block.tMin, t);
    block.tMax = Math.max(block.tMax, t);
}

// Copy surviving rows to a new file. Mapped cutoffs stay exact even when several rows have the same timestamp.
async function compactSamplingArchive({ dataPath, outputPath, cutoff, generations }, cuts = [], pinned = new Map()) {
    const encoder = new ArchiveEncoder();
    const selected = new Map(generations);
    const timeIndex = [];
    const checkpoints = [...new Set(cuts)].sort((a, b) => a - b);
    const offsets = new Map();
    let checkpoint = 0;
    let bytes = 0;
    let rows = 0;
    let batch = [];
    let batchBytes = 0;
    const file = await fs.open(outputPath, "wx");
    const records = readArchive(dataPath, { end: cutoff });
    const flush = async () => {
        const buffer = Buffer.concat(batch, batchBytes);
        let written = 0;
        while (written < buffer.length) {
            const { bytesWritten } = await file.write(buffer, written, buffer.length - written);
            if (!bytesWritten) throw new Error("Archive compaction write made no progress");
            written += bytesWritten;
        }
        batch = [];
        batchBytes = 0;
    };
    try {
        let next;
        while (!(next = await records.next()).done) {
            const { t, scope, generation, v, identities, end } = next.value;
            while (checkpoints[checkpoint] < end) offsets.set(checkpoints[checkpoint++], bytes);
            if ((selected.get(scope) || 0) !== generation && !pinned.get(scope)?.has(generation)) continue;
            const row = encoder.encodeRow({
                t,
                scope,
                generation,
                values: Object.entries(v).map(([key, text]) => ({ key, text, identity: identities?.[key] || "" }))
            });
            indexSampleTime(timeIndex, bytes, t);
            if (rows++ === 0) {
                batch.push(FILE_HEADER);
                batchBytes += FILE_HEADER.length;
                bytes += FILE_HEADER.length;
            }
            batch.push(row);
            batchBytes += row.length;
            bytes += row.length;
            if (batchBytes >= WRITE_BATCH_BYTES) await flush();
        }
        if (next.value.end !== cutoff) throw new Error("Archive compaction stopped before the last written record");
        while (checkpoint < checkpoints.length) offsets.set(checkpoints[checkpoint++], bytes);
        if (batchBytes) await flush();
        await file.datasync();
        return { bytes, rows, timeIndex, dictionary: encoder.dictionary(), offsets };
    } finally {
        await records.return(undefined);
        await file.close();
    }
}

module.exports = { compactSamplingArchive, indexSampleTime };
