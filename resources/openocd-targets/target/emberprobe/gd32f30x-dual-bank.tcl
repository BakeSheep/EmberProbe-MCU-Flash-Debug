# SPDX-License-Identifier: GPL-2.0-or-later

source [find target/swj-dp.tcl]

if {![info exists CHIPNAME]} { set CHIPNAME gd32f30x }
if {![info exists CPUTAPID]} {
    set CPUTAPID [expr {[using_jtag] ? 0x4ba00477 : 0x2ba01477}]
}
if {![info exists WORKAREASIZE]} { set WORKAREASIZE 0x1000 }
if {![info exists FLASH_KIB] || $FLASH_KIB ni {1024 2048 3072}} {
    error "GD32F30x: select a supported dual-bank Flash capacity"
}

swj_newdap $CHIPNAME cpu -irlen 4 -ircapture 0x1 -irmask 0xf -expected-id $CPUTAPID
dap create $CHIPNAME.dap -chain-position $CHIPNAME.cpu
if {[using_jtag]} { jtag newtap $CHIPNAME bs -irlen 5 }

set _TARGETNAME $CHIPNAME.cpu
target create $_TARGETNAME cortex_m -endian little -dap $CHIPNAME.dap
$_TARGETNAME configure -work-area-phys 0x20000000 -work-area-size $WORKAREASIZE -work-area-backup 0
flash bank $CHIPNAME.flash0 gd32f30x 0x08000000 0x80000 0 0 $_TARGETNAME $FLASH_KIB
flash bank $CHIPNAME.flash1 gd32f30x 0x08080000 [expr {($FLASH_KIB - 512) * 1024}] 0 0 $_TARGETNAME $FLASH_KIB

adapter speed 1000
adapter srst delay 100
if {[using_jtag]} { jtag_ntrst_delay 100 }
reset_config srst_nogate
if {![using_hla]} { cortex_m reset_config sysresetreq }

proc ep_gd32f30x_require_banks {chip} {
    if {[catch {flash probe $chip.flash0; flash probe $chip.flash1} reason]} {
        echo "GD32F30x Flash bank probe failed: $reason"
        shutdown error
        error $reason
    }
}
lappend post_init_commands [list ep_gd32f30x_require_banks $CHIPNAME]
