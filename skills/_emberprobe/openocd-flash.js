"use strict";

// The file word is already quoted by quoteTclWord. Delegate to OpenOCD's program/reset
// implementations, retaining target events, verification, RAM backup and final reset-run.
function buildFlashProgramCommand(fileWord) {
    return (
        "proc _ep_flash_program {file} { local proc reset {args} { " +
        "echo EP_FLASH_STAGE=reset_[lindex $args 0]; upcall reset {*}$args }; " +
        "echo EP_FLASH_STAGE=init; program $file verify reset exit }; " +
        `_ep_flash_program ${fileWord}`
    );
}

function flashPhaseFromLine(line, previous = "openocd_start") {
    const marker = String(line).match(/^\s*EP_FLASH_STAGE=(init|reset_init|reset_halt|reset_run)\s*$/);
    if (marker) return marker[1];
    if (/programming started/i.test(line)) return "program";
    if (/verify started/i.test(line)) return "verify";
    if (/resetting target/i.test(line)) return "reset_run";
    return previous;
}

module.exports = { buildFlashProgramCommand, flashPhaseFromLine };
