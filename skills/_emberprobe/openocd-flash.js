"use strict";
const { normalizeAdapterSpeed, probeFamily } = require("./probe-connection");

// Clock requested while programming when the user leaves adapterSpeedKhz at 0. Drivers clamp it to the
// probe's own ceiling (ST-Link V2 4 MHz, V3 24 MHz; J-Link reports its model maximum; CMSIS-DAP firmware
// uses its fastest divider), so these are upper requests rather than promises.
const FLASH_SPEED_KHZ = Object.freeze({ stlink: 24000, jlink: 15000, "cmsis-dap": 10000 });

function flashSpeedKhz(connection = {}) {
    return normalizeAdapterSpeed(connection.adapterSpeedKhz) || FLASH_SPEED_KHZ[probeFamily(connection)] || 0;
}

// Raise the SWD clock after reset-init has set up the target clocks. Only Cortex-M over SWD: its DP is
// asynchronous to the core clock. A CPUID read-back must match before the faster clock is kept.
// Returns the previous kHz to fall back to, or 0 when the clock is unchanged.
const BOOST_PROC =
    "proc _ep_flash_boost {khz} { " +
    "if {$khz <= 0 || [catch { set t [target current]; " +
    "expr {[$t cget -type] in {cortex_m hla_target} && [transport select] in {swd hla_swd dapdirect_swd}} } ok] || !$ok} { return 0 }; " +
    "if {![regexp {(\\d+)\\s*kHz} [adapter speed] -> base] || $base >= $khz} { return 0 }; " +
    "if {[catch {read_memory 0xE000ED00 32 1} expected]} { return 0 }; " +
    "if {[catch {adapter speed $khz}] || [catch {read_memory 0xE000ED00 32 1} actual] || $actual ne $expected} { " +
    "catch {adapter speed $base}; return 0 }; " +
    "if {![regexp {(\\d+)\\s*kHz} [adapter speed] -> now] || $now <= $base} { return 0 }; " +
    "echo EP_FLASH_SPEED=$now; return $base }; ";

// Restore the clock that reset-init chose and repeat reset-init before the single slow retry.
const SLOW_PROC =
    "proc _ep_flash_slow {} { echo EP_FLASH_STAGE=speed_fallback; adapter speed $::_ep_flash_base; " +
    "set ::_ep_flash_base 0; set ::_ep_flash_khz 0; reset init }; ";

function requiresFlashBounds(target) {
    return /^(?:artery\/at32f4(?:x(?:-1024)?|3x-1024)|gigadevice\/gd32f[13](?:x0|0x)(?:-\d+)?|geehy\/apm32(?:e103(?:-512)?|e030)|wch\/ch32f103(?:-32)?)\.cfg$/i.test(
        target
    );
}

function buildFlashBoundsCommand(ranges) {
    const merged = [];
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end <= start ||
            end > 0x100000000
        )
            throw new Error("Invalid Flash image address interval");
        const last = merged.at(-1);
        if (last && last[1] >= start) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    // Keep the command within both Windows argv and the GDB monitor packet budget.
    if (!merged.length || merged.length > 128) throw new Error("Expected 1 to 128 nonoverlapping Flash image ranges");
    const intervals = merged.map(([start, end]) => `{${start} ${end}}`).join(" ");
    return (
        "proc _ep_flash_check {ranges} { " +
        "set target [target current]; set banks {}; foreach bank [flash list] { " +
        "if {[dict get $bank target] eq $target} { flash probe [dict get $bank name] } }; " +
        "foreach bank [flash list] { if {[dict get $bank target] eq $target} { " +
        "set base [dict get $bank base]; set size [dict get $bank size]; " +
        "if {$size > 0} { lappend banks [list $base [expr {$base + $size}]] } } }; " +
        'if {![llength $banks]} { set msg "No Flash banks could be verified for the current target"; echo "EP_FLASH_BOUNDS_ERROR $msg"; error $msg }; ' +
        "set banks [lsort -integer -index 0 $banks]; foreach range $ranges { " +
        "lassign $range next end; foreach bank $banks { lassign $bank low high; " +
        "if {$next >= $low && $next < $high} { set next $high }; if {$next >= $end} { break } }; " +
        'if {$next < $end} { set msg [format "Image address 0x%08x is outside the configured Flash banks" $next]; echo "EP_FLASH_BOUNDS_ERROR $msg"; error $msg } } }; ' +
        `_ep_flash_check {${intervals}}; ` +
        "echo EP_FLASH_BOUNDS_OK"
    );
}

// The file word is already quoted by quoteTclWord. OpenOCD owns reset, writes, verification and
// target events. Validate Flash bounds before the first write and optionally raise the clock.
function buildFlashProgramCommand(fileWord, speedKhz = 0, ranges = undefined) {
    const khz = normalizeAdapterSpeed(speedKhz);
    const bounds = ranges ? `${buildFlashBoundsCommand(ranges)}; ` : "";
    return (
        BOOST_PROC +
        SLOW_PROC +
        `proc _ep_flash_program {file} { set ::_ep_flash_khz ${khz}; set ::_ep_flash_base 0; ` +
        "local proc reset {args} { echo EP_FLASH_STAGE=reset_[lindex $args 0]; upcall reset {*}$args }; " +
        "local proc flash {args} { " +
        'if {[llength $args] != 3 || [lindex $args 0] ne "write_image" || [lindex $args 1] ne "erase"} { ' +
        "return [upcall flash {*}$args] }; " +
        bounds +
        "set ::_ep_flash_base [_ep_flash_boost $::_ep_flash_khz]; " +
        "if {!$::_ep_flash_base} { echo EP_FLASH_STAGE=program; return [upcall flash {*}$args] }; " +
        "echo EP_FLASH_STAGE=program_boost; if {![catch {upcall flash {*}$args}]} { return }; " +
        "_ep_flash_slow; echo EP_FLASH_STAGE=program; upcall flash {*}$args }; " +
        "local proc verify_image {args} { if {!$::_ep_flash_base} { return [upcall verify_image {*}$args] }; " +
        "echo EP_FLASH_STAGE=verify_boost; if {![catch {upcall verify_image {*}$args}]} { return }; " +
        "_ep_flash_slow; echo EP_FLASH_STAGE=program; upcall flash write_image erase {*}$args; " +
        "echo EP_FLASH_STAGE=verify; upcall verify_image {*}$args }; " +
        "echo EP_FLASH_STAGE=init; program $file verify reset exit }; " +
        `_ep_flash_program ${fileWord}`
    );
}

// The same raise for a GDB download over `monitor`: the previous clock stays in a Tcl global for
// DOWNLOAD_CLOCK_RESTORE and is printed, with BOOST_PROC's EP_FLASH_SPEED, for the adapter to read.
function buildDownloadBoostCommand(speedKhz) {
    const khz = normalizeAdapterSpeed(speedKhz);
    return BOOST_PROC + `set ::_ep_download_base [_ep_flash_boost ${khz}]; echo EP_DOWNLOAD_BASE=$::_ep_download_base`;
}

const DOWNLOAD_CLOCK_RESTORE =
    "if {[info exists ::_ep_download_base] && $::_ep_download_base} { adapter speed $::_ep_download_base }; " +
    "set ::_ep_download_base 0";

const FLASH_STAGE =
    /^\s*EP_FLASH_STAGE=(init|reset_init|reset_halt|reset_run|program|program_boost|verify|verify_boost|speed_fallback)\s*$/;

// J-Link logs its clamp before the marker; other drivers already report the effective clock in the marker.
function flashClockTracker() {
    let reduced = null;
    return (line) => {
        const clamp = String(line).match(/Reduced speed from (\d+) kHz to (\d+) kHz/i);
        if (clamp) reduced = { from: Number(clamp[1]), to: Number(clamp[2]) };
        const marker = String(line).match(/^\s*EP_FLASH_SPEED=(\d+)\s*$/);
        if (!marker) return 0;
        const khz = Number(marker[1]);
        return reduced?.from === khz ? reduced.to : khz;
    };
}

function flashPhaseFromLine(line, previous = "openocd_start") {
    const marker = String(line).match(FLASH_STAGE);
    if (marker) return marker[1];
    if (/programming started/i.test(line)) return "program";
    if (/verify started/i.test(line)) return "verify";
    if (/resetting target/i.test(line)) return "reset_run";
    return previous;
}

// Errors logged while trying the raised clock are expected and handled in Tcl.
function isTentativeFlashPhase(phase) {
    return phase === "program_boost" || phase === "verify_boost";
}

module.exports = {
    FLASH_SPEED_KHZ,
    flashSpeedKhz,
    buildFlashProgramCommand,
    requiresFlashBounds,
    buildFlashBoundsCommand,
    buildDownloadBoostCommand,
    DOWNLOAD_CLOCK_RESTORE,
    flashClockTracker,
    flashPhaseFromLine,
    isTentativeFlashPhase
};
