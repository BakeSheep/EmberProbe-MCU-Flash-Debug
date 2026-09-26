"use strict";
const assert = require("assert");
const { controlTarget } = require("../src/chipInfo");

(async () => {
    const options = { executable: "openocd", probe: "stlink.cfg", target: "stm32f4x.cfg" };
    for (const [action, command, state] of [
        ["pause", "halt", "halted"],
        ["continue", "resume", "running"],
        ["reset", "reset run", "running"]
    ]) {
        const result = await controlTarget(
            {
                ...options,
                run: async (request) => {
                    const commands = request.buildCommands();
                    assert.deepStrictEqual([commands[0], commands[2]], ["init", "shutdown"]);
                    assert.ok(commands[1].includes(command));
                    assert.ok(commands[1].includes("poll"));
                    if (action !== "reset") assert.ok(commands[1].includes("Target is no longer"));
                    request.onLine(`EP_CONTROL_OK ${state}`);
                    return { exitCode: 0 };
                }
            },
            action
        );
        assert.strictEqual(result.state, state);
    }
    await assert.rejects(
        () => controlTarget(options, "invalid"),
        (error) => error.code === "CHIP_ACTION_INVALID"
    );
    await assert.rejects(
        () =>
            controlTarget(
                {
                    ...options,
                    run: async (request) => {
                        request.onLine("EP_CONTROL_ERROR Target is no longer running");
                        return { exitCode: 0 };
                    }
                },
                "pause"
            ),
        (error) => error.code === "CHIP_CONTROL_FAILED" && /no longer running/.test(error.message)
    );
    await assert.rejects(
        () =>
            controlTarget(
                { ...options, run: async () => ({ exitCode: 1, diagnostic: { message: "probe lost" } }) },
                "reset"
            ),
        (error) => error.code === "CHIP_CONTROL_FAILED" && /probe lost/.test(error.message)
    );
    console.log("Chip control tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
