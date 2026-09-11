"use strict";
// 将片上 Flash 与本地 ELF 比对（OpenOCD verify_image）：halt 目标、校验、恢复原运行状态。
// 先输出预检 JSON，--execute 输出 {verified, elf, elfSha256, detail} 并以退出码反映结果。
const fs = require("fs");
const { call } = require("../../_emberprobe/agent-client");
const { parseArgs, preflight, emit, isSafeCfgPath } = require("../../_emberprobe/flash-common");

function fail(message) {
    process.stderr.write(message + "\n");
    process.exit(1);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await preflight(options);
    emit(result);
    if (!result.ready) fail("Detection incomplete. Provide or select ELF, target, and probe.");
    if (!fs.existsSync(result.elf)) fail(`ELF not found: ${result.elf}`);
    if (!isSafeCfgPath(result.target) || !isSafeCfgPath(result.probe)) fail("Unsafe OpenOCD configuration path.");
    if (!options.execute) return;
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
