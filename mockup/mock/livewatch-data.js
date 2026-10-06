/*
 * Fake extension-host payloads for the EmberProbe Live Watch webview.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeLiveWatchData = factory();
})(globalThis, function () {
    "use strict";

    var VERSION = "mock-elf-8f3c21";

    var SYMBOLS = [
        {
            name: "g_sensor_temp",
            displayName: "g_sensor_temp",
            address: 0x20000040,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_motor_rpm",
            displayName: "g_motor_rpm",
            address: 0x20000044,
            size: 2,
            typeName: "uint16_t",
            watchType: "u16",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_bus_voltage",
            displayName: "g_bus_voltage",
            address: 0x20000048,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_bus_current",
            displayName: "g_bus_current",
            address: 0x2000004c,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_pid_kp",
            displayName: "g_pid_kp",
            address: 0x20000064,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_pid_ki",
            displayName: "g_pid_ki",
            address: 0x20000068,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_setpoint",
            displayName: "g_setpoint",
            address: 0x20000070,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_measured",
            displayName: "g_measured",
            address: 0x20000074,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_pwm_duty",
            displayName: "g_pwm_duty",
            address: 0x20000078,
            size: 2,
            typeName: "uint16_t",
            watchType: "u16",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_uart_tx_count",
            displayName: "g_uart_tx_count",
            address: 0x2000007c,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_uart_rx_count",
            displayName: "g_uart_rx_count",
            address: 0x20000080,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_error_count",
            displayName: "g_error_count",
            address: 0x20000050,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_warn_count",
            displayName: "g_warn_count",
            address: 0x20000054,
            size: 2,
            typeName: "uint16_t",
            watchType: "u16",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_state",
            displayName: "g_state",
            address: 0x20000058,
            size: 1,
            typeName: "uint8_t",
            watchType: "u8",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_target_rpm",
            displayName: "g_target_rpm",
            address: 0x20000060,
            size: 2,
            typeName: "uint16_t",
            watchType: "u16",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_loop_time_us",
            displayName: "g_loop_time_us",
            address: 0x20000094,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_control_dt",
            displayName: "g_control_dt",
            address: 0x20000098,
            size: 4,
            typeName: "float",
            watchType: "f32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "g_motor_enabled",
            displayName: "g_motor_enabled",
            address: 0x200000a0,
            size: 1,
            typeName: "bool",
            watchType: "u8",
            isComposite: false,
            hasDwarfWriteType: true,
            isBoolean: true
        },
        {
            name: "g_debug_counter",
            displayName: "g_debug_counter",
            address: 0x200000a4,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        },
        {
            name: "system_core_clock",
            displayName: "system_core_clock",
            address: 0x200000a8,
            size: 4,
            typeName: "uint32_t",
            watchType: "u32",
            isComposite: false,
            hasDwarfWriteType: true
        }
    ];

    function watchItem(name) {
        var symbol = SYMBOLS.filter(function (entry) {
            return entry.name === name;
        })[0];
        return {
            name: symbol.name,
            displayName: symbol.displayName,
            address: symbol.address,
            size: symbol.size,
            type: symbol.watchType
        };
    }

    function watchList() {
        return ["g_sensor_temp", "g_motor_rpm", "g_bus_voltage"].map(watchItem);
    }

    var SERIES_STYLES = {
        g_sensor_temp: { color: "#1684C5", line: "solid" },
        g_motor_rpm: { color: "#CE4242", line: "solid" },
        g_bus_voltage: { color: "#22855A", line: "solid" }
    };

    return {
        VERSION: VERSION,
        SYMBOLS: SYMBOLS,
        watchList: watchList,
        seriesStyles: SERIES_STYLES
    };
});
