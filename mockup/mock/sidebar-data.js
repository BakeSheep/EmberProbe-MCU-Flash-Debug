/*
 * Fake extension-host payloads for the EmberProbe sidebar webview.
 * Runs inside the mock shell page (browser) and can also be required by Node
 * tooling (smoke test) because of the UMD wrapper.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSidebarData = factory();
})(globalThis, function () {
    "use strict";

    var VERSION = "mock-elf-8f3c21";
    var SVD_PATH = "C:\\Users\\dev\\.emberprobe\\svd\\STM32F407.svd";
    var ELF_PATH = "C:\\Users\\dev\\EmberProbeDemo\\build\\Debug\\EmberProbeDemo.elf";
    var CONNECTION = {
        elf: ELF_PATH,
        probe: "jlink.cfg",
        target: "stm32f4x.cfg",
        deviceId: "0x0009a413",
        probeName: "J-Link V9",
        probeVersion: "V9 compiled May  7 2021 16:26:12",
        clock: "2000 kHz"
    };

    /* ------------------------------------------------------------------ symbols */

    function scalar(name, address, size, typeName, watchType, extra) {
        return Object.assign(
            {
                name: name,
                displayName: name,
                address: address,
                size: size,
                typeName: typeName,
                watchType: watchType,
                isComposite: false,
                hasDwarfWriteType: /^(u|i|f)\d+$/.test(watchType)
            },
            extra || {}
        );
    }

    function arrayLayout(typeName, watchType, count) {
        var width = /64/.test(watchType) ? 8 : /16/.test(watchType) ? 2 : /8/.test(watchType) ? 1 : 4;
        return {
            kind: "array",
            typeName: typeName,
            byteSize: width * count,
            totalElements: count,
            elementType: { typeName: typeName.replace(/\[.*\]/, ""), watchType: watchType, byteSize: width }
        };
    }

    function structMember(name, offset, watchType, typeName) {
        return { name: name, offset: offset, watchType: watchType, typeName: typeName };
    }

    var IMU_LAYOUT = {
        kind: "struct",
        typeName: "imu_sample_t",
        byteSize: 32,
        members: [
            { name: "accel", offset: 0, compositeLayout: arrayLayout("float[3]", "f32", 3) },
            { name: "gyro", offset: 12, compositeLayout: arrayLayout("float[3]", "f32", 3) },
            structMember("temp", 24, "f32", "float"),
            structMember("timestamp", 28, "u32", "uint32_t")
        ]
    };

    var ADC_LAYOUT = arrayLayout("uint16_t[16]", "u16", 16);

    function composite(name, address, size, typeName, layout, extra) {
        return Object.assign(
            {
                name: name,
                displayName: name,
                address: address,
                size: size,
                typeName: typeName,
                watchType: "",
                isComposite: true,
                hasRuntimeLayout: false,
                hasDwarfWriteType: false,
                compositeLayout: layout
            },
            extra || {}
        );
    }

    var SYMBOLS = [
        scalar("g_sensor_temp", 0x20000040, 4, "float", "f32"),
        scalar("g_motor_rpm", 0x20000044, 2, "uint16_t", "u16"),
        scalar("g_bus_voltage", 0x20000048, 4, "float", "f32"),
        scalar("g_bus_current", 0x2000004c, 4, "float", "f32"),
        scalar("g_error_count", 0x20000050, 4, "uint32_t", "u32"),
        scalar("g_warn_count", 0x20000054, 2, "uint16_t", "u16"),
        scalar("g_state", 0x20000058, 1, "uint8_t", "u8"),
        scalar("g_target_rpm", 0x20000060, 2, "uint16_t", "u16"),
        scalar("g_pid_kp", 0x20000064, 4, "float", "f32"),
        scalar("g_pid_ki", 0x20000068, 4, "float", "f32"),
        scalar("g_pid_kd", 0x2000006c, 4, "float", "f32"),
        scalar("g_setpoint", 0x20000070, 4, "float", "f32"),
        scalar("g_measured", 0x20000074, 4, "float", "f32"),
        scalar("g_pwm_duty", 0x20000078, 2, "uint16_t", "u16"),
        scalar("g_uart_tx_count", 0x2000007c, 4, "uint32_t", "u32"),
        scalar("g_uart_rx_count", 0x20000080, 4, "uint32_t", "u32"),
        scalar("g_can_last_id", 0x20000084, 4, "uint32_t", "u32"),
        scalar("g_watchdog_kick", 0x20000088, 4, "uint32_t", "u32"),
        scalar("g_heap_used", 0x2000008c, 4, "uint32_t", "u32"),
        scalar("g_stack_high_water", 0x20000090, 4, "uint32_t", "u32"),
        scalar("g_loop_time_us", 0x20000094, 4, "uint32_t", "u32"),
        scalar("g_control_dt", 0x20000098, 4, "float", "f32"),
        scalar("g_temp_limit", 0x2000009c, 4, "const float", "f32", { isConst: true }),
        scalar("g_motor_enabled", 0x200000a0, 1, "bool", "u8", { isBoolean: true }),
        scalar("g_debug_counter", 0x200000a4, 4, "uint32_t", "u32"),
        scalar("system_core_clock", 0x200000a8, 4, "uint32_t", "u32"),
        scalar("SystemCoreClock", 0x200000ac, 4, "uint32_t", "u32"),
        composite("g_adc_samples", 0x200000c0, 32, "uint16_t[16]", ADC_LAYOUT),
        composite("g_imu", 0x20000100, 32, "imu_sample_t", IMU_LAYOUT)
    ];

    /* ------------------------------------------------------------- watch lists */

    function watchItem(name) {
        var symbol = SYMBOLS.filter(function (entry) {
            return entry.name === name;
        })[0];
        if (!symbol) throw new Error("Unknown mock symbol: " + name);
        if (symbol.isComposite)
            return {
                name: symbol.name,
                displayName: symbol.displayName,
                address: symbol.address,
                size: symbol.size,
                type: "",
                isComposite: true,
                compositeLayout: symbol.compositeLayout
            };
        return {
            name: symbol.name,
            displayName: symbol.displayName,
            address: symbol.address,
            size: symbol.size,
            type: symbol.watchType
        };
    }

    function sidebarWatchList() {
        return ["g_sensor_temp", "g_motor_rpm", "g_bus_voltage", "g_imu"].map(watchItem);
    }

    function sidebarWriteList() {
        return [
            Object.assign(watchItem("g_target_rpm"), { min: 0, max: 3000 }),
            Object.assign(watchItem("g_pid_kp"), { min: 0, max: 5 })
        ];
    }

    function graphWatchList() {
        return ["g_sensor_temp", "g_motor_rpm", "g_bus_voltage"].map(watchItem);
    }

    /* ------------------------------------------------------------------- memory */

    function memoryAnalysis() {
        return {
            type: "memoryAnalysis",
            state: "ready",
            requestId: Date.now(),
            result: {
                elf: { path: ELF_PATH },
                flash: { total: 917504, estimated: false },
                ram: { total: 42880, estimated: false },
                regions: [
                    {
                        name: "FLASH",
                        used: 917504,
                        capacity: 1048576,
                        percent: 87.5,
                        sectionBytes: 917504,
                        sections: [
                            {
                                name: ".isr_vector",
                                runtimeAddress: "0x08000000",
                                loadAddress: "0x08000000",
                                size: 372,
                                role: "runtime",
                                address: "0x08000000"
                            },
                            {
                                name: ".text",
                                runtimeAddress: "0x080000cc",
                                loadAddress: "0x080000cc",
                                size: 764120,
                                role: "runtime",
                                address: "0x080000cc"
                            },
                            {
                                name: ".rodata",
                                runtimeAddress: "0x080ba9d4",
                                loadAddress: "0x080ba9d4",
                                size: 142836,
                                role: "runtime",
                                address: "0x080ba9d4"
                            },
                            {
                                name: ".ARM.extab",
                                runtimeAddress: "0x080ddb88",
                                loadAddress: "0x080ddb88",
                                size: 1120,
                                role: "runtime",
                                address: "0x080ddb88"
                            },
                            {
                                name: ".ARM",
                                runtimeAddress: "0x080ddff0",
                                loadAddress: "0x080ddff0",
                                size: 8280,
                                role: "runtime",
                                address: "0x080ddff0"
                            },
                            {
                                name: ".data",
                                runtimeAddress: "0x20000000",
                                loadAddress: "0x080dfff8",
                                size: 776,
                                role: "load",
                                address: "0x080dfff8"
                            }
                        ]
                    },
                    {
                        name: "RAM",
                        used: 42880,
                        capacity: 131072,
                        percent: 32.7,
                        sectionBytes: 42880,
                        sections: [
                            {
                                name: ".data",
                                runtimeAddress: "0x20000000",
                                loadAddress: "0x080dfff8",
                                size: 776,
                                role: "runtime",
                                address: "0x20000000"
                            },
                            {
                                name: ".bss",
                                runtimeAddress: "0x2000030c",
                                loadAddress: "—",
                                size: 35456,
                                role: "runtime",
                                address: "0x2000030c"
                            },
                            {
                                name: ".heap",
                                runtimeAddress: "0x20008dc0",
                                loadAddress: "—",
                                size: 4096,
                                role: "runtime",
                                address: "0x20008dc0"
                            },
                            {
                                name: ".stack",
                                runtimeAddress: "0x20009dc0",
                                loadAddress: "—",
                                size: 2552,
                                role: "runtime",
                                address: "0x20009dc0"
                            }
                        ]
                    },
                    {
                        name: "CCMRAM",
                        used: 1088,
                        capacity: 65536,
                        percent: 1.66,
                        sectionBytes: 1088,
                        sections: [
                            {
                                name: ".ccmram",
                                runtimeAddress: "0x10000000",
                                loadAddress: "—",
                                size: 1088,
                                role: "runtime",
                                address: "0x10000000"
                            }
                        ]
                    }
                ],
                diagnostics: [],
                source: {
                    elf: { path: ELF_PATH },
                    mapFile: "C:\\Users\\dev\\EmberProbeDemo\\build\\Debug\\EmberProbeDemo.map"
                },
                topSymbols: [
                    { name: "g_adc_samples", displayName: "g_adc_samples", section: ".bss", size: 32 },
                    { name: "g_imu", displayName: "g_imu", section: ".bss", size: 32 },
                    { name: "g_motor_state", displayName: "g_motor_state", section: ".bss", size: 24 },
                    { name: "g_uart_rx_buffer", displayName: "g_uart_rx_buffer", section: ".bss", size: 1024 },
                    { name: "g_can_filter", displayName: "g_can_filter", section: ".data", size: 16 },
                    { name: "g_pid_kp", displayName: "g_pid_kp", section: ".data", size: 4 }
                ]
            }
        };
    }

    /* --------------------------------------------------------------- chip info */

    function chipInfo() {
        return {
            type: "chipInfo",
            info: {
                core: "Cortex-M4",
                coreRevision: "r0p1",
                deviceId: CONNECTION.deviceId,
                revId: "0x0009",
                designer: "STMicroelectronics",
                designerCode: "JEP106:020 STMicroelectronics",
                romDesigner: "",
                romPart: "0x413",
                flashSize: "1024 KB",
                endian: "little",
                uid: "0x002E 004D 3038 5157 3236 3813",
                targetState: "halted",
                haltReason: "断点命中 · main.c:103",
                pc: "0x08001a3c",
                sp: "0x2001ffb0",
                lr: "0x080012b7",
                probe: "J-Link",
                probeName: CONNECTION.probeName,
                probeVersion: CONNECTION.probeVersion,
                transport: "SWD",
                clock: CONNECTION.clock,
                voltage: "3.30 V",
                targetName: "STM32F407ZGTx",
                authenticity: "genuine",
                series: "STM32F4",
                chip: "STM32F407ZG",
                readAt: Date.now() - 45000,
                stateError: ""
            }
        };
    }

    function chipInfoStatus(state, key) {
        return { type: "chipInfoStatus", state: state, key: key || "" };
    }

    /* --------------------------------------------------------------------- rtos */

    var RTOS_SESSION = "mock-debug-session-1";

    function rtosDebugStatus(state, stopEpoch) {
        return {
            type: "rtosDebugStatus",
            state: state,
            stopEpoch: stopEpoch || 0,
            inspectionEpoch: 1,
            sessionId: ["paused", "running"].includes(state) ? RTOS_SESSION : "",
            supported: ["paused", "running"].includes(state),
            sessions: ["paused", "running"].includes(state)
                ? [{ id: RTOS_SESSION, name: "EmberProbe (J-Link)", serverGroup: "Cortex-M4", targetProcessor: 0 }]
                : []
        };
    }

    function rtosSnapshot(stopEpoch) {
        function task(name, state, priority, base, tcb, stackBase, savedSp, total, unused, runtime) {
            return {
                taskKey: name + ":" + tcb,
                name: name,
                state: state,
                priority: priority,
                basePriority: base,
                tcbAddress: tcb,
                threadId: "",
                stack: {
                    baseAddress: stackBase,
                    savedPointer: savedSp,
                    totalBytes: total,
                    fillEstimate: { complete: true, usedPercent: ((total - unused) / total) * 100, unusedBytes: unused }
                },
                runtime: { counter: runtime }
            };
        }
        return {
            type: "rtosSnapshot",
            sessionId: RTOS_SESSION,
            stopEpoch: stopEpoch,
            inspectionEpoch: 1,
            partial: false,
            diagnostics: [],
            tasks: [
                task("IDLE", "Ready", 0, 0, "0x20000210", "0x20001000", "0x200011d0", 512, 428, 1284421),
                task("Tmr Svc", "Blocked", 2, 2, "0x20000298", "0x20001200", "0x200012e4", 512, 356, 88114),
                task("SensorTask", "Blocked", 4, 4, "0x20000320", "0x20001400", "0x20001508", 1024, 772, 302118),
                task("ControlTask", "Running", 5, 5, "0x200003a8", "0x20001800", "0x2000189c", 1024, 624, 664022),
                task("CommsTask", "Blocked", 3, 3, "0x20000430", "0x20001c00", "0x20001d44", 2048, 1610, 201775),
                task("LoggerTask", "Suspended", 1, 1, "0x200004b8", "0x20002400", "0x200024f8", 1024, 940, 12987)
            ]
        };
    }

    /* -------------------------------------------------------------- peripherals */

    function field(name, bitOffset, bitWidth, access, extra) {
        return Object.assign(
            {
                name: name,
                path: "", // filled by register builder
                description: name,
                bitOffset: bitOffset,
                bitWidth: bitWidth,
                access: access
            },
            extra || {}
        );
    }

    function reg(base, name, offset, access, fields, description) {
        var path = base + "." + name;
        var mapped = (fields || []).map(function (item) {
            return Object.assign({}, item, { path: path + "." + item.name });
        });
        return {
            path: path,
            name: name,
            description: description || name,
            address: "0x" + (offset | 0).toString(16).toUpperCase(),
            size: 32,
            access: access,
            fields: mapped
        };
    }

    function bits(prefix, count, width, access, start) {
        var list = [];
        for (var i = 0; i < count; i++) list.push(field(prefix + i, (start || 0) + i * width, width, access));
        return list;
    }

    function gpioRegisters(port) {
        return [
            reg(port, "MODER", 0x00, "read-write", bits("MODER", 16, 2, "read-write")),
            reg(port, "OTYPER", 0x04, "read-write", bits("OT", 16, 1, "read-write")),
            reg(port, "OSPEEDR", 0x08, "read-write", bits("OSPEEDR", 16, 2, "read-write")),
            reg(port, "PUPDR", 0x0c, "read-write", bits("PUPDR", 16, 2, "read-write")),
            reg(port, "IDR", 0x10, "read-only", bits("IDR", 16, 1, "read-only")),
            reg(port, "ODR", 0x14, "read-write", bits("ODR", 16, 1, "read-write")),
            reg(
                port,
                "BSRR",
                0x18,
                "write-only",
                bits("BS", 16, 1, "write-only").concat(bits("BR", 16, 1, "write-only", 16))
            ),
            reg(port, "AFRL", 0x20, "read-write", bits("AFRL", 8, 4, "read-write")),
            reg(port, "AFRH", 0x24, "read-write", bits("AFRH", 8, 4, "read-write"))
        ];
    }

    var PERIPHERALS = [
        { name: "GPIOA", description: "General-purpose I/Os (port A)", registers: gpioRegisters("GPIOA") },
        {
            name: "TIM2",
            description: "Advanced-timer / general-purpose timer 2",
            registers: [
                reg("TIM2", "CR1", 0x00, "read-write", [
                    field("CEN", 0, 1, "read-write", {
                        enumerations: [
                            { name: "Disabled", value: 0 },
                            { name: "Enabled", value: 1 }
                        ]
                    }),
                    field("UDIS", 1, 1, "read-write"),
                    field("URS", 2, 1, "read-write"),
                    field("OPM", 3, 1, "read-write"),
                    field("DIR", 4, 1, "read-write", {
                        enumerations: [
                            { name: "Up", value: 0 },
                            { name: "Down", value: 1 }
                        ]
                    }),
                    field("CMS", 5, 2, "read-write"),
                    field("ARPE", 7, 1, "read-write"),
                    field("CKD", 8, 2, "read-write")
                ]),
                reg("TIM2", "SR", 0x10, "read-write", [
                    field("UIF", 0, 1, "read-write"),
                    field("CC1IF", 1, 1, "read-write"),
                    field("CC2IF", 2, 1, "read-write"),
                    field("CC3IF", 3, 1, "read-write"),
                    field("CC4IF", 4, 1, "read-write"),
                    field("TIF", 6, 1, "read-write")
                ]),
                reg("TIM2", "EGR", 0x14, "write-only", [
                    field("UG", 0, 1, "write-only"),
                    field("CC1G", 1, 1, "write-only")
                ]),
                reg("TIM2", "CNT", 0x24, "read-write", [field("CNT", 0, 32, "read-write")]),
                reg("TIM2", "PSC", 0x28, "read-write", [field("PSC", 0, 16, "read-write")]),
                reg("TIM2", "ARR", 0x2c, "read-write", [field("ARR", 0, 16, "read-write")]),
                reg("TIM2", "CCR1", 0x34, "read-write", [field("CCR1", 0, 16, "read-write")])
            ]
        },
        {
            name: "USART1",
            description: "Universal synchronous asynchronous receiver transmitter",
            registers: [
                reg("USART1", "SR", 0x00, "read-only", [
                    field("PE", 0, 1, "read-only"),
                    field("FE", 1, 1, "read-only"),
                    field("NE", 2, 1, "read-only"),
                    field("ORE", 3, 1, "read-only"),
                    field("IDLE", 4, 1, "read-only"),
                    field("RXNE", 5, 1, "read-only"),
                    field("TC", 6, 1, "read-only"),
                    field("TXE", 7, 1, "read-only"),
                    field("LBD", 8, 1, "read-only"),
                    field("CTS", 9, 1, "read-only")
                ]),
                reg("USART1", "DR", 0x04, "read-write", [field("DR", 0, 9, "read-write")]),
                reg("USART1", "BRR", 0x08, "read-write", [
                    field("DIV_Fraction", 0, 4, "read-write"),
                    field("DIV_Mantissa", 4, 12, "read-write")
                ]),
                reg("USART1", "CR1", 0x0c, "read-write", [
                    field("SBK", 0, 1, "read-write"),
                    field("RWU", 1, 1, "read-write"),
                    field("RE", 2, 1, "read-write"),
                    field("TE", 3, 1, "read-write"),
                    field("IDLEIE", 4, 1, "read-write"),
                    field("RXNEIE", 5, 1, "read-write"),
                    field("TCIE", 6, 1, "read-write"),
                    field("TXEIE", 7, 1, "read-write"),
                    field("PEIE", 8, 1, "read-write"),
                    field("PS", 9, 1, "read-write"),
                    field("PCE", 10, 1, "read-write"),
                    field("WAKE", 11, 1, "read-write"),
                    field("M", 12, 1, "read-write"),
                    field("UE", 13, 1, "read-write"),
                    field("OVER8", 15, 1, "read-write")
                ]),
                reg("USART1", "CR2", 0x10, "read-write", [field("STOP", 12, 2, "read-write")]),
                reg("USART1", "CR3", 0x14, "read-write", [
                    field("EIE", 0, 1, "read-write"),
                    field("HDSEL", 3, 1, "read-write")
                ]),
                reg("USART1", "GTPR", 0x18, "read-write", [
                    field("PSC", 0, 8, "read-write"),
                    field("GT", 8, 8, "read-write")
                ])
            ]
        },
        {
            name: "ADC1",
            description: "12-bit analog-to-digital converter",
            registers: [
                reg("ADC1", "SR", 0x00, "read-write", [
                    field("AWD", 0, 1, "read-write"),
                    field("EOC", 1, 1, "read-write"),
                    field("JEOC", 2, 1, "read-write"),
                    field("JSTRT", 3, 1, "read-write"),
                    field("STRT", 4, 1, "read-write"),
                    field("OVR", 5, 1, "read-write")
                ]),
                reg("ADC1", "CR1", 0x04, "read-write", [
                    field("AWDCH", 0, 5, "read-write"),
                    field("EOCIE", 5, 1, "read-write"),
                    field("AWDIE", 6, 1, "read-write"),
                    field("JEOCIE", 7, 1, "read-write"),
                    field("SCAN", 8, 1, "read-write"),
                    field("AWDSGL", 9, 1, "read-write"),
                    field("JAUTO", 10, 1, "read-write"),
                    field("DISCEN", 11, 1, "read-write"),
                    field("JDISCEN", 12, 1, "read-write"),
                    field("DISCNUM", 13, 3, "read-write"),
                    field("RES", 24, 2, "read-write"),
                    field("OVRIE", 26, 1, "read-write")
                ]),
                reg("ADC1", "CR2", 0x08, "read-write", [
                    field("ADON", 0, 1, "read-write"),
                    field("CONT", 1, 1, "read-write"),
                    field("DMA", 8, 1, "read-write"),
                    field("DDS", 9, 1, "read-write"),
                    field("EOCS", 10, 1, "read-write"),
                    field("ALIGN", 11, 1, "read-write"),
                    field("EXTSEL", 24, 4, "read-write"),
                    field("EXTEN", 28, 2, "read-write"),
                    field("SWSTART", 30, 1, "read-write")
                ]),
                reg("ADC1", "SMPR1", 0x0c, "read-write", [
                    field("SMP10", 0, 3, "read-write"),
                    field("SMP11", 3, 3, "read-write"),
                    field("SMP12", 6, 3, "read-write")
                ]),
                reg("ADC1", "DR", 0x4c, "read-only", [field("DATA", 0, 16, "read-only")])
            ]
        },
        {
            name: "RCC",
            description: "Reset and clock control",
            registers: [
                reg("RCC", "CR", 0x00, "read-write", [
                    field("HSION", 0, 1, "read-write"),
                    field("HSIRDY", 1, 1, "read-only"),
                    field("HSEON", 16, 1, "read-write"),
                    field("HSERDY", 17, 1, "read-only"),
                    field("HSEBYP", 18, 1, "read-write"),
                    field("CSSON", 19, 1, "read-write"),
                    field("PLLON", 24, 1, "read-write"),
                    field("PLLRDY", 25, 1, "read-only")
                ]),
                reg("RCC", "PLLCFGR", 0x04, "read-write", [
                    field("PLLM", 0, 6, "read-write"),
                    field("PLLN", 6, 9, "read-write"),
                    field("PLLP", 16, 2, "read-write"),
                    field("PLLSRC", 22, 1, "read-write"),
                    field("PLLQ", 24, 4, "read-write")
                ]),
                reg("RCC", "CFGR", 0x08, "read-write", [
                    field("SW", 0, 2, "read-write"),
                    field("SWS", 2, 2, "read-only"),
                    field("HPRE", 4, 4, "read-write"),
                    field("PPRE1", 10, 3, "read-write"),
                    field("PPRE2", 13, 3, "read-write")
                ]),
                reg("RCC", "AHB1ENR", 0x30, "read-write", [
                    field("GPIOAEN", 0, 1, "read-write"),
                    field("GPIOBEN", 1, 1, "read-write"),
                    field("GPIOCEN", 2, 1, "read-write"),
                    field("GPIODEN", 3, 1, "read-write"),
                    field("GPIOEEN", 4, 1, "read-write"),
                    field("CRCEN", 12, 1, "read-write"),
                    field("DMA1EN", 21, 1, "read-write"),
                    field("DMA2EN", 22, 1, "read-write"),
                    field("ETHMACEN", 25, 1, "read-write")
                ])
            ]
        },
        {
            name: "SYSCFG",
            description: "System configuration controller",
            registers: [
                reg("SYSCFG", "MEMRMP", 0x00, "read-write", [
                    field("MEM_MODE", 0, 3, "read-write"),
                    field("MII_RMII_SEL", 23, 1, "read-write")
                ]),
                reg("SYSCFG", "PMC", 0x04, "read-write", [field("MII_RMII_READ", 23, 1, "read-write")])
            ]
        }
    ];

    var REGISTER_VALUES = {
        "GPIOA.MODER": 0xab000400,
        "GPIOA.OTYPER": 0x0000,
        "GPIOA.OSPEEDR": 0x0c000000,
        "GPIOA.PUPDR": 0x64000000,
        "GPIOA.IDR": 0x000032c8,
        "GPIOA.ODR": 0x00003201,
        "GPIOA.AFRL": 0x7700,
        "GPIOA.AFRH": 0x0,
        "TIM2.CR1": 0x0001,
        "TIM2.SR": 0x0001,
        "TIM2.CNT": 0x0000a3c7,
        "TIM2.PSC": 0x0000,
        "TIM2.ARR": 0x0000ffff,
        "TIM2.CCR1": 0x00007fff,
        "USART1.SR": 0x00c0,
        "USART1.DR": 0x0041,
        "USART1.BRR": 0x0683,
        "USART1.CR1": 0x200c,
        "USART1.CR2": 0x0000,
        "USART1.CR3": 0x0000,
        "USART1.GTPR": 0x0000,
        "ADC1.SR": 0x0002,
        "ADC1.CR1": 0x0100,
        "ADC1.CR2": 0x0001,
        "ADC1.SMPR1": 0x0387,
        "ADC1.DR": 0x0b7d,
        "RCC.CR": 0x0303d001,
        "RCC.PLLCFGR": 0x24003008,
        "RCC.CFGR": 0x0000940a,
        "RCC.AHB1ENR": 0x0010001f,
        "SYSCFG.MEMRMP": 0x00000000,
        "SYSCFG.PMC": 0x00000000
    };

    function peripheralCatalog() {
        return {
            type: "peripheralCatalog",
            svd: { path: SVD_PATH, sha256: "mock-svd-sha256" },
            peripherals: PERIPHERALS.map(function (item) {
                return {
                    name: item.name,
                    description: item.description,
                    registerNames: item.registers.map(function (register) {
                        return register.name;
                    })
                };
            })
        };
    }

    function peripheralRegisters(name) {
        var peripheral = PERIPHERALS.filter(function (item) {
            return item.name === name;
        })[0];
        return { type: "peripheralRegisters", name: name, registers: peripheral ? peripheral.registers : [] };
    }

    function bitValue(value, offset, width) {
        return Number((BigInt(value >>> 0) >> BigInt(offset)) & ((1n << BigInt(width)) - 1n));
    }

    function enumFor(fieldName, value) {
        if (fieldName === "CEN") return value ? "Enabled" : "Disabled";
        return null;
    }

    function peripheralReadResult(targets, mutate) {
        var registers = (targets || []).map(function (path) {
            var current = REGISTER_VALUES[path];
            if (current === undefined) return { path: path, value: null, error: "寄存器未在模拟数据中定义" };
            if (mutate) {
                var mask = 0x1 << (Math.floor(Math.random() * 16) + 16);
                current = path.indexOf(".IDR") >= 0 ? current ^ mask : current;
                if (path.indexOf(".CNT") >= 0) current = (current + 0x3d) & 0xffffffff;
                REGISTER_VALUES[path] = current;
            }
            var peripheral = PERIPHERALS.filter(function (item) {
                return path.indexOf(item.name + ".") === 0;
            })[0];
            var register = peripheral
                ? peripheral.registers.filter(function (item) {
                      return item.path === path;
                  })[0]
                : null;
            var fields = register
                ? register.fields.map(function (item) {
                      var value = bitValue(current, item.bitOffset, item.bitWidth);
                      var enumText = enumFor(item.name, value);
                      return Object.assign(
                          { path: item.path, value: value },
                          enumText ? { enum: enumText, enumDescription: enumText } : {}
                      );
                  })
                : [];
            return { path: path, value: current, fields: fields };
        });
        return { type: "peripheralReadResult", session: { epoch: 1 }, registers: registers };
    }

    function peripheralWriteResult(target, value) {
        var parts = String(target || "").split(".");
        var base = parts.slice(0, 2).join(".");
        var peripheral = PERIPHERALS.find(function (item) {
            return item.name === parts[0];
        });
        var register =
            peripheral &&
            peripheral.registers.find(function (item) {
                return item.path === base;
            });
        var field =
            register &&
            parts.length === 3 &&
            register.fields.find(function (item) {
                return item.path === target;
            });
        var bits = field ? field.bitWidth : 32;
        var raw = String(value).trim().replace(/_/g, "");
        var enumeration =
            field &&
            (field.enumerations || []).find(function (item) {
                return item.name.toLowerCase() === raw.toLowerCase();
            });
        var numeric = enumeration
            ? Number(enumeration.value)
            : /^(?:\+?\d+|0x[0-9a-f]+|0b[01]+|#[01]+)$/i.test(raw)
              ? Number(raw[0] === "#" ? "0b" + raw.slice(1) : raw)
              : NaN;
        if (
            !register ||
            REGISTER_VALUES[base] === undefined ||
            parts.length > 3 ||
            (parts.length === 3 && !field) ||
            register.access === "read-only" ||
            (field && field.access === "read-only") ||
            !Number.isSafeInteger(numeric) ||
            numeric < 0 ||
            numeric >= 2 ** bits
        ) {
            return {
                type: "peripheralError",
                operation: "peripheralWriteRequest",
                target: target,
                message: "无效或只读的寄存器写入"
            };
        }
        if (field) {
            var mask = ((1n << BigInt(bits)) - 1n) << BigInt(field.bitOffset);
            REGISTER_VALUES[base] = Number(
                (BigInt(REGISTER_VALUES[base] >>> 0) & ~mask) | (BigInt(numeric) << BigInt(field.bitOffset))
            );
        } else REGISTER_VALUES[base] = numeric;
        return { type: "peripheralWriteResult", target: target, result: { results: [{ register: base }] } };
    }

    /* -------------------------------------------------------------- simulation */

    function createSimulator() {
        var overrides = new Map();
        var state = {
            temp: 36.4,
            rpm: 1450,
            voltage: 24.02,
            current: 1.82,
            errors: 3,
            warns: 12,
            now: Date.now(),
            loopTimeUs: 840,
            adc: [],
            imu: { accel: [0.02, -0.01, 0.98], gyro: [0.4, -0.2, 0.1], temp: 36.8, timestamp: 0 }
        };
        for (var i = 0; i < 16; i++) state.adc.push(2048 + Math.round(Math.sin(i / 3) * 120));
        var initial = JSON.parse(JSON.stringify(state));
        function noise(amount) {
            return (Math.random() - 0.5) * amount;
        }
        function round(value, digits) {
            var factor = Math.pow(10, digits);
            return Math.round(value * factor) / factor;
        }
        function tick() {
            state.now = Date.now();
            state.loopTimeUs = 840 + Math.round(noise(60));
            state.temp = round(state.temp + noise(0.06) + (36.5 - state.temp) * 0.02, 3);
            state.rpm = Math.max(0, Math.min(65535, Math.round(state.rpm + noise(6))));
            state.voltage = round(state.voltage + noise(0.02), 3);
            state.current = round(state.current + noise(0.01), 3);
            if (Math.random() < 0.004) state.errors += 1;
            if (Math.random() < 0.02) state.warns += 1;
            state.adc = state.adc.map(function (value, index) {
                return Math.max(
                    0,
                    Math.min(4095, Math.round(value + noise(10) + Math.sin(index + Date.now() / 400) * 2))
                );
            });
            state.imu.accel = state.imu.accel.map(function (value, index) {
                return round(value + noise(0.01) + (index === 2 ? 0 : 0), 4);
            });
            state.imu.gyro = state.imu.gyro.map(function (value) {
                return round(value + noise(0.02), 4);
            });
            state.imu.temp = round(state.temp + noise(0.05), 3);
            state.imu.timestamp = Date.now() & 0xffffffff;
        }
        function scalarSamples(names, t) {
            var values = {
                g_sensor_temp: state.temp,
                g_motor_rpm: state.rpm,
                g_bus_voltage: state.voltage,
                g_bus_current: state.current,
                g_error_count: state.errors,
                g_warn_count: state.warns,
                g_state: Math.floor(state.now / 2000) % 4,
                g_target_rpm: 1500,
                g_pid_kp: 1.85,
                g_pid_ki: 0.42,
                g_pid_kd: 0.06,
                g_setpoint: 1500,
                g_measured: state.rpm,
                g_pwm_duty: Math.min(1000, Math.round(state.rpm / 2)),
                g_uart_tx_count: 12844 + (Math.floor(state.now / 1000) % 1000),
                g_uart_rx_count: 9120 + (Math.floor(state.now / 1000) % 700),
                g_can_last_id: 0x18ff50e5,
                g_watchdog_kick: 88213,
                g_heap_used: 35456,
                g_stack_high_water: 412,
                g_loop_time_us: state.loopTimeUs,
                g_control_dt: 0.001,
                g_temp_limit: 85,
                g_motor_enabled: 1,
                g_debug_counter: 991,
                system_core_clock: 168000000,
                SystemCoreClock: 168000000
            };
            return (names || [])
                .map(function (name) {
                    return { name: name, value: overrides.has(name) ? overrides.get(name) : values[name], t: t };
                })
                .filter(function (sample) {
                    return sample.value !== undefined;
                });
        }
        function write(name, value) {
            var symbol = SYMBOLS.find(function (item) {
                return item.name === name;
            });
            if (!symbol || symbol.isConst || symbol.isComposite || !Number.isFinite(value)) return false;
            var type = symbol.watchType;
            var bits = Number(type.slice(1));
            if (symbol.isBoolean && value !== 0 && value !== 1) return false;
            if (
                type[0] !== "f" &&
                (!Number.isInteger(value) ||
                    value < (type[0] === "i" ? -(2 ** (bits - 1)) : 0) ||
                    value > (type[0] === "i" ? 2 ** (bits - 1) - 1 : 2 ** bits - 1))
            )
                return false;
            var stored = type === "f32" ? Math.fround(value) : value;
            if (!Number.isFinite(stored)) return false;
            overrides.set(name, stored);
            return true;
        }
        function compositeSample(name, t) {
            if (name === "g_imu") {
                return {
                    name: name,
                    t: t,
                    tree: {
                        kind: "struct",
                        typeName: "imu_sample_t",
                        byteSize: 32,
                        offset: 0,
                        members: [
                            {
                                name: "accel",
                                kind: "array",
                                typeName: "float[3]",
                                offset: 0,
                                elements: state.imu.accel.map(function (value, index) {
                                    return {
                                        index: index,
                                        offset: index * 4,
                                        value: value,
                                        valueText: null,
                                        type: "f32"
                                    };
                                })
                            },
                            {
                                name: "gyro",
                                kind: "array",
                                typeName: "float[3]",
                                offset: 12,
                                elements: state.imu.gyro.map(function (value, index) {
                                    return {
                                        index: index,
                                        offset: 12 + index * 4,
                                        value: value,
                                        valueText: null,
                                        type: "f32"
                                    };
                                })
                            },
                            {
                                name: "temp",
                                offset: 24,
                                value: state.imu.temp,
                                valueText: null,
                                type: "f32",
                                typeName: "float"
                            },
                            {
                                name: "timestamp",
                                offset: 28,
                                value: state.imu.timestamp,
                                valueText: null,
                                type: "u32",
                                typeName: "uint32_t"
                            }
                        ]
                    }
                };
            }
            if (name === "g_adc_samples") {
                return {
                    name: name,
                    t: t,
                    tree: {
                        kind: "array",
                        typeName: "uint16_t[16]",
                        byteSize: 32,
                        offset: 0,
                        elementType: { typeName: "uint16_t", watchType: "u16", byteSize: 2 },
                        elements: state.adc.map(function (value, index) {
                            return { index: index, offset: index * 2, value: value, valueText: null, type: "u16" };
                        })
                    }
                };
            }
            return null;
        }
        return {
            tick: tick,
            scalarSamples: scalarSamples,
            compositeSample: compositeSample,
            write: write,
            reset: function () {
                overrides.clear();
                state = JSON.parse(JSON.stringify(initial));
                state.now = Date.now();
            }
        };
    }

    return {
        VERSION: VERSION,
        CONNECTION: CONNECTION,
        SVD_PATH: SVD_PATH,
        SYMBOLS: SYMBOLS,
        watchItem: watchItem,
        sidebarWatchList: sidebarWatchList,
        sidebarWriteList: sidebarWriteList,
        graphWatchList: graphWatchList,
        memoryAnalysis: memoryAnalysis,
        chipInfo: chipInfo,
        chipInfoStatus: chipInfoStatus,
        rtosDebugStatus: rtosDebugStatus,
        rtosSnapshot: rtosSnapshot,
        peripheralCatalog: peripheralCatalog,
        peripheralRegisters: peripheralRegisters,
        peripheralReadResult: peripheralReadResult,
        peripheralWriteResult: peripheralWriteResult,
        createSimulator: createSimulator
    };
});
