# SPDX-License-Identifier: GPL-2.0-or-later

set _ep_compat_capacities {
    gd32f10x {16 32 64 128 256 384 512}
    gd32f30x {256 384 512}
    apm32e103 {256 512}
    apm32e030 {64}
    ch32f103 {32 64}
}
set _ep_compat_sizes [dict get $_ep_compat_capacities [lindex $_EP_COMPAT_FLASH 0]]
if {$FLASH_SIZE % 1024 || [expr {$FLASH_SIZE / 1024}] ni $_ep_compat_sizes} {
    error "Unsupported single-bank Flash capacity for [lindex $_EP_COMPAT_FLASH 0]"
}
source [find target/stm32f1x.cfg]

proc ep_compat_check_flash {device core idaddr mask ids sizeaddr width size} {
    set id [mrw $idaddr]
    set matched 0
    foreach expected $ids {
        if {($id & $mask) == $expected} { set matched 1; break }
    }
    if {(([mrw 0xe000ed00] >> 4) & 0xfff) != $core || !$matched} {
        error [format "%s Flash bank: unsupported device ID 0x%08x" $device $id]
    }
    if {[string match gd32* $device]} {
        # Unlike the shared STM32 DEV_ID, the CoreSight designer identifies GigaDevice.
        set p1 [mrw 0xe00fffe4]
        set p2 [mrw 0xe00fffe8]
        set bank [expr {[mrw 0xe00fffd0] & 0xf}]
        set designer [expr {(($p2 & 7) << 4) | (($p1 >> 4) & 15)}]
        if {!($p2 & 8) || !(($bank == 6 && $designer == 0x48) || ($bank == 7 && $designer == 0x51))} {
            error "$device Flash bank: CoreSight designer does not identify GigaDevice"
        }
        if {$device eq "gd32f10x" && (($id >> 16) & 0xffff) == 0x1303} {
            error "$device Flash bank: use the GD32F1x0 configuration for this revision"
        }
    }
    if {$sizeaddr != 0} {
        set measured [lindex [read_memory $sizeaddr $width 1] 0]
        if {$measured eq "" || ($measured & 0xffff) * 1024 != $size} {
            error "$device Flash bank: device capacity does not match the selected configuration"
        }
    }
}

proc ep_compat_require_flash {args} {
    if {[catch {ep_compat_check_flash {*}$args} reason]} {
        echo $reason
        shutdown error
        error $reason
    }
}

$_TARGETNAME configure -event examine-end {}
lappend post_init_commands [list ep_compat_require_flash {*}${_EP_COMPAT_FLASH} $_FLASH_SIZE]
