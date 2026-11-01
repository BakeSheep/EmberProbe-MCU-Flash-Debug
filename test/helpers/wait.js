"use strict";
// Real-time waits for tests that cross a Worker, a child process or file I/O, where a FakeClock cannot drive time.
// Prefer waitFor: it returns as soon as the condition holds instead of sleeping for a worst-case delay.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message = "condition not met in time", timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await wait(2);
    }
}

module.exports = { wait, waitFor };
