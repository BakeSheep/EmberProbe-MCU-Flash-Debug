"use strict";
// Runs one named test scenario (sync or async) and prefixes any failure with its name,
// so a failing assertion identifies the scenario without a test framework.
function scenario(name, run) {
    const fail = (error) => {
        error.message = name + ": " + error.message;
        if (error.stack) error.stack = name + ": " + error.stack;
        throw error;
    };
    try {
        const result = run();
        return result && typeof result.then === "function" ? result.catch(fail) : result;
    } catch (error) {
        return fail(error);
    }
}
module.exports = { scenario };
