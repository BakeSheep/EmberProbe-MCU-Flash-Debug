"use strict";
// 将片上 Flash 与本地 ELF 比对（OpenOCD verify_image）：halt 目标、校验、恢复原运行状态。
// 先输出预检 JSON，--execute 输出 {verified, elf, elfSha256, detail} 并以退出码反映结果。
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
        fail("ELF changed during verify preflight. Retry so the comparison stays consistent.");
    }
    const elfWord = tclQuote(toPosix(result.elf));
    // 单条 Tcl 块：记录原状态 → 非 halted 则 halt → verify_image → 按原状态 resume → shutdown，
    // EP_VERIFY 标记行用于机器判定结果（verify_image 的比对失败通过 catch 捕获）
    const verify = 'set o [[target current] curstate]; set h 0; if {$o ne "halted"} { if {![catch {halt}]} { set h 1 } }; '
        + `set rc [catch { verify_image ${elfWord} } msg]; `
        + 'if {$rc} { echo "EP_VERIFY FAIL $msg" } else { echo "EP_VERIFY OK" }; '
        + 'if {$h} { catch { resume } }; shutdown';
    let run;
    try {
        run = await runOpenOcd(result.openocd, ["-f", `interface/${result.probe}`, "-f", `target/${result.target}`, "-c", "init", "-c", verify]);
    } catch (error) {
        fail(`Failed to start OpenOCD (${error.code || error.message}). Check the openocd executable or path.`);
    }
    // 标记行以行首锚定匹配：避免把回显参数/日志中携带的 Tcl 文本误判为结果
    const okLine = run.lines.find(line => /^\s*EP_VERIFY OK\b/.test(line));
    const failLine = run.lines.find(line => /^\s*EP_VERIFY FAIL\b/.test(line));
    const verified = Boolean(okLine && !failLine);
    const detail = failLine ? failLine.replace(/^.*EP_VERIFY FAIL\s*/, "").trim() : "";
    emit({ verified, elf: result.elf, elfSha256: result.elfSha256, detail });
    if (!okLine && !failLine) {
        fail("OpenOCD did not reach the verification step. Check probe connection and target power.");
    }
    process.exitCode = verified ? 0 : 1;
}

if (require.main === module) main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
