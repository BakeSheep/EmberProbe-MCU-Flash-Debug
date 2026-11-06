"use strict";

const LINE_BYTES = 64;
const UINT32_RANGE = 0x100000000;
const delta32 = (after, before) => (after - before) >>> 0;

// The fixture writes 64-byte ASCII records; only LF terminates a record. Joining raw chunks preserves split records
// without converting invalid bytes through UTF-8, or treating a 63-byte unterminated tail as a complete record.
function checkStream(chunks, envelope) {
    const data = Buffer.concat(
        (Array.isArray(chunks) ? chunks : [chunks]).map((chunk) =>
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        )
    );
    if (
        envelope &&
        (!Number.isInteger(envelope.firstSequence) ||
            envelope.firstSequence < 0 ||
            envelope.firstSequence >= UINT32_RANGE ||
            !Number.isSafeInteger(envelope.attempts) ||
            envelope.attempts < 0 ||
            envelope.attempts >= UINT32_RANGE / 2)
    )
        throw new Error("A finite stream needs a uint32 firstSequence and fewer than 2^31 attempts");
    const result = {
        rawBytes: data.length,
        lines: 0,
        terminatedLines: 0,
        malformed: 0,
        partialBytes: 0,
        duplicates: 0,
        resets: 0,
        internalGaps: 0,
        outOfEnvelope: 0,
        first: null,
        last: null
    };
    const sequences = new Set();
    const offsets = new Set();
    let previous = null;
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        const line = data.subarray(start, end + 1);
        start = end + 1;
        result.terminatedLines++;
        const match = /^S ([0-9a-f]{8}) /u.exec(line.subarray(0, 11).toString("latin1"));
        const seq = match ? parseInt(match[1], 16) : null;
        let intact = seq !== null && line.length === LINE_BYTES;
        for (let column = 11; intact && column < LINE_BYTES - 1; column++) {
            // uint32 arithmetic matches the C fixture, including seq + column overflow before modulo 26.
            intact = line[column] === 97 + (((seq + column) >>> 0) % 26);
        }
        if (!intact) {
            result.malformed++;
            continue;
        }
        result.lines++;
        if (result.first === null) result.first = seq;
        if (sequences.has(seq)) result.duplicates++;
        sequences.add(seq);
        if (previous !== null) {
            const distance = delta32(seq, previous);
            if (distance >= UINT32_RANGE / 2) result.resets++;
            else if (distance > 1) result.internalGaps += distance - 1;
        }
        previous = seq;
        result.last = seq;
        if (envelope) {
            const offset = delta32(seq, envelope.firstSequence);
            if (offset >= envelope.attempts) result.outOfEnvelope++;
            else offsets.add(offset);
        }
    }
    result.partialBytes = data.length - start;
    // A free-running capture cannot establish leading/trailing loss; do not claim a finite loss of zero from it.
    result.missingLines = null;
    result.complete = false;
    if (envelope) {
        let firstOffset = envelope.attempts;
        let lastOffset = -1;
        for (const offset of offsets) {
            firstOffset = Math.min(firstOffset, offset);
            lastOffset = Math.max(lastOffset, offset);
        }
        result.attempts = envelope.attempts;
        result.attemptedBytes = envelope.attempts * LINE_BYTES;
        result.missingLines = envelope.attempts - offsets.size;
        result.missingLeading = firstOffset;
        result.missingTrailing = offsets.size ? envelope.attempts - lastOffset - 1 : 0;
        result.missingInternal = result.missingLines - result.missingLeading - result.missingTrailing;
        result.complete =
            result.missingLines === 0 &&
            result.rawBytes === result.attemptedBytes &&
            result.malformed === 0 &&
            result.partialBytes === 0 &&
            result.duplicates === 0 &&
            result.resets === 0 &&
            result.outOfEnvelope === 0;
    }
    return result;
}

// status.mode is the fixture's shadow, not a readback of RTT descriptor Flags after a host mode change.
function parseFixtureStatus(text) {
    const header = /^status: profile=(\w+) cb=0x([0-9a-f]{8}) up=(\d+)s rate=(\d+) seq=(\d+)\r?\n/mu.exec(text);
    const channels = [
        ...text.matchAll(/^status: ch(\d+) mode=(skip|trim|block) written=(\d+) dropped=(\d+) maxCycles=(\d+)\r?\n/gmu)
    ];
    if (!header || !channels.some((match) => match[1] === "0") || !channels.some((match) => match[1] === "1"))
        return null;
    const uint32 = (value) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number >= UINT32_RANGE)
            throw new Error(`Invalid fixture uint32: ${value}`);
        return number;
    };
    return {
        profile: header[1],
        controlBlock: parseInt(header[2], 16),
        uptimeSeconds: uint32(header[3]),
        rate: uint32(header[4]),
        sequence: uint32(header[5]),
        channels: Object.fromEntries(
            channels.map((match) => [
                match[1],
                {
                    shadowMode: match[2],
                    written: uint32(match[3]),
                    dropped: uint32(match[4]),
                    maxWriteCycles: uint32(match[5])
                }
            ])
        )
    };
}

function fixtureDelta(before, after) {
    if (before.controlBlock !== after.controlBlock || before.profile !== after.profile)
        throw new Error("Fixture identity changed during stream capture");
    const attempts = delta32(after.sequence, before.sequence);
    if (attempts >= UINT32_RANGE / 2) throw new Error("Fixture sequence reset during stream capture");
    const first = before.channels[1];
    const last = after.channels[1];
    const acceptedBytes = delta32(last.written, first.written);
    const rejectedBytes = delta32(last.dropped, first.dropped);
    if (acceptedBytes + rejectedBytes !== attempts * LINE_BYTES)
        throw new Error("Fixture counters do not account for exactly 64 bytes per attempt");
    return {
        firstSequence: before.sequence,
        attempts,
        attemptedBytes: attempts * LINE_BYTES,
        acceptedBytes,
        rejectedBytes,
        // Lifetime maxima are observations, never subtract them to claim burst duration or blocking time.
        lifetimeMaxWriteCyclesBefore: first.maxWriteCycles,
        lifetimeMaxWriteCyclesAfter: last.maxWriteCycles
    };
}

module.exports = { LINE_BYTES, checkStream, delta32, fixtureDelta, parseFixtureStatus };
