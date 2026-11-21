# SPDX-License-Identifier: GPL-2.0-or-later

source [find target/swj-dp.tcl]

if {![info exists CHIPNAME]} { set CHIPNAME at32f4x }
if {![info exists _EP_ARTERY_DUAL_ARGS]} { set _EP_ARTERY_DUAL_ARGS {} }
if {![info exists CPUTAPID]} {
    set CPUTAPID [expr {[using_jtag] ? 0x4ba00477 : 0x1ba01477}]
}
swj_newdap $CHIPNAME cpu -irlen 4 -ircapture 0x1 -irmask 0xf -expected-id $CPUTAPID
dap create $CHIPNAME.dap -chain-position $CHIPNAME.cpu

set _TARGETNAME $CHIPNAME.cpu
target create $_TARGETNAME cortex_m -endian little -dap $CHIPNAME.dap
flash bank $CHIPNAME.flash0 artery_dual 0x08000000 0x80000 0 0 $_TARGETNAME {*}${_EP_ARTERY_DUAL_ARGS}
flash bank $CHIPNAME.flash1 artery_dual 0x08080000 0x80000 0 0 $_TARGETNAME {*}${_EP_ARTERY_DUAL_ARGS}

adapter speed 1000
if {![using_hla]} { cortex_m reset_config sysresetreq }

proc ep_artery_require_dual_banks {chip} {
    if {[catch {flash probe $chip.flash0; flash probe $chip.flash1} reason]} {
        echo "AT32 Flash bank probe failed: $reason"
        shutdown error
        error $reason
    }
}
lappend post_init_commands [list ep_artery_require_dual_banks $CHIPNAME]
