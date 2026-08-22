"use strict";
// 将工作区 ELF 固件烧录到 MCU（OpenOCD program ... verify reset exit）。
// 先输出预检 JSON（含检测到的 ELF/目标/探针/OpenOCD），--execute 才真正执行烧录。
const fs = require("fs");
const {
    parseArgs, preflight, emit, sha256, isSafeCfgPath, tclQuote, toPosix, runOpenOcd
} = require("../../_emberprobe/flash-common");

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
    const currentHash = await sha256(result.elf);
    if (currentHash !== result.elfSha256) {
        fail("ELF changed during download preflight. Retry so addresses and firmware stay consistent.");
    }
    const program = `program ${tclQuote(toPosix(result.elf))} verify reset exit`;
    let run;
    try {
        run = await runOpenOcd(result.openocd, ["-f", `interface/${result.probe}`, "-f", `target/${result.target}`, "-c", program]);
    } catch (error) {
        fail(`Failed to start OpenOCD (${error.code || error.message}). Check the openocd executable or path.`);
    }
    process.exit(run.code);
}

if (require.main === module) main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
