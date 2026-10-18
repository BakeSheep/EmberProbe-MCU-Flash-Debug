"use strict";
// 将片上 Flash 与本地 ELF 比对（OpenOCD verify_image）：halt 目标、校验、恢复原运行状态。
// 先输出预检 JSON，--execute 输出 {verified, elf, elfSha256, detail} 并以退出码反映结果。
const fs = require("fs");
const { call } = require("../../_emberprobe/agent-client");
const {
    parseArgs,
    preflight,
    emit,
    isSafeCfgPath,
    probeSerialOverride,
    authorizeFlash
} = require("../../_emberprobe/flash-common");

function fail(message) {
    process.stderr.write(message + "\n");
    process.exit(1);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.remember || options.permission || options["reset-permission"])
        fail("Flash verification supports one-time confirmation only; manage programming permission with program.js.");
    const result = await preflight(options);
    if (!result.ready) {
        emit(result);
        if (options.execute) fail("OpenOCD preflight failed: " + result.notes.join(" "));
        return;
    }
    if (!fs.existsSync(result.elf)) fail(`ELF not found: ${result.elf}`);
    if (!isSafeCfgPath(result.target) || !isSafeCfgPath(result.probe)) fail("Unsafe OpenOCD configuration path.");
    if (!options.execute) {
        // An incompatible OpenOCD cannot verify, so no confirmation plan is requested for it.
        if (!result.openocdCompatible) return emit(result);
        // The preflight is reported even when the Bridge cannot issue a plan (for example, a busy probe).
        let verificationAuthorization;
        try {
            verificationAuthorization = await authorizeFlash(result, undefined, "flash.verify");
        } catch (error) {
            emit({
                ...result,
                verificationAuthorizationError: { ...(error.code ? { code: error.code } : {}), message: error.message }
            });
            fail(`Verification confirmation plan unavailable: ${error.message}`);
        }
        emit({ ...result, verificationAuthorization });
        return;
    }
    emit(result);
    if (!options["confirmation-id"])
        fail(
            "Verification confirmation is required. Show the preflight plan in the Agent conversation, then rerun with --execute --confirmation-id <id> only after explicit approval."
        );
    if (!result.openocdCompatible) {
        fail(
            `Incompatible OpenOCD ${result.openocdVersion || "(unknown version)"}; EmberProbe requires ${result.minimumOpenocdVersion} or newer. Upgrade OpenOCD${process.platform === "win32" ? " or select EmberProbe's bundled xPack build" : ""}.`
        );
    }
    const executed = await call(
        result.workspace,
        "flash.verify",
        {
            elf: result.elf,
            elfSha256: result.elfSha256,
            target: result.target,
            probe: result.probe,
            openocd: result.openocd,
            transport: result.transport,
            probeSerial: probeSerialOverride(result),
            adapterSpeedKhz: result.adapterSpeedKhz,
            confirmationId: options["confirmation-id"]
        },
        150000
    );
    for (const line of executed.lines || []) process.stdout.write(line + "\n");
    emit(executed);
    process.exitCode = executed.code;
}

if (require.main === module)
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
