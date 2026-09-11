"use strict";
// 将工作区 ELF 固件烧录到 MCU（OpenOCD program ... verify reset exit）。
// 先输出预检 JSON（含检测到的 ELF/目标/探针/OpenOCD），--execute 才真正执行烧录。
const fs = require("fs");
const { call } = require("../../_emberprobe/agent-client");
const { parseArgs, preflight, emit, isSafeCfgPath, authorizeFlash } = require("../../_emberprobe/flash-common");

function fail(message) {
    process.stderr.write(message + "\n");
    process.exit(1);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await preflight(options);
    if (!result.ready) fail("Detection incomplete. Provide or select ELF, target, and probe.");
    if (!fs.existsSync(result.elf)) fail(`ELF not found: ${result.elf}`);
    if (!isSafeCfgPath(result.target) || !isSafeCfgPath(result.probe)) fail("Unsafe OpenOCD configuration path.");
    let authorization;
    try {
        authorization = options.execute ? { authorized: !!options["confirmation-id"] } : await authorizeFlash(result);
    } catch (error) {
        if (!options.execute) {
            emit({
                ...result,
                flashAuthorization: {
                    unavailable: true,
                    code: error.code || "BRIDGE_UNAVAILABLE",
                    message: "Execution requires one-time authorization from the EmberProbe extension Bridge"
                }
            });
            return;
        }
        fail(
            `EmberProbe flash authorization failed (${error.code || error.message}). Open the trusted workspace and reinstall its EmberProbe Agent Skills.`
        );
    }
    emit({ ...result, flashAuthorization: authorization });
    if (!options.execute) return;
    if (!authorization || authorization.authorized !== true) {
        fail(
            "Flash confirmation is required. Show the preflight details to the user, then rerun with --execute --confirmation-id <id> only after explicit approval."
        );
    }
    if (!result.openocdCompatible) {
        fail(
            `Incompatible OpenOCD ${result.openocdVersion || "(unknown version)"}; EmberProbe requires ${result.minimumOpenocdVersion} or newer. Upgrade OpenOCD${process.platform === "win32" ? " or select EmberProbe's bundled xPack build" : ""}.`
        );
    }
    const executed = await call(
        result.workspace,
        "flash.execute",
        {
            elf: result.elf,
            elfSha256: result.elfSha256,
            target: result.target,
            probe: result.probe,
            openocd: result.openocd,
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
