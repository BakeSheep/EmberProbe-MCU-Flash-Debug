/*
 * Static content for the VS Code shell mock: file tree, source files,
 * debug session data, terminal output and the command palette list.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeShellData = factory();
})(globalThis, function () {
    "use strict";

    var MAIN_C = [
        "/**",
        " * @file    main.c",
        " * @brief   EmberProbeDemo — FOC 电机控制器演示 (STM32F407ZGTx)",
        " *",
        " * 通过 EmberProbe 扩展可以实时观察下列全局变量、外设寄存器与 FreeRTOS 任务。",
        " */",
        "",
        '#include "main.h"',
        '#include "cmsis_os.h"',
        '#include "FreeRTOS.h"',
        '#include "task.h"',
        '#include "queue.h"',
        '#include "pid.h"',
        '#include "imu.h"',
        '#include "adc.h"',
        "",
        "#define CONTROL_PERIOD_MS   1",
        "#define SENSOR_PERIOD_MS    5",
        "#define COMMS_PERIOD_MS     20",
        "#define MOTOR_POLE_PAIRS    7",
        "",
        "/* 实时变量面板观察的全局量 */",
        "float    g_sensor_temp   = 36.4f;",
        "uint16_t g_motor_rpm     = 0;",
        "float    g_bus_voltage   = 24.0f;",
        "float    g_bus_current   = 0.0f;",
        "uint32_t g_error_count   = 0;",
        "uint16_t g_warn_count    = 0;",
        "uint8_t  g_state         = 0;",
        "uint16_t g_target_rpm    = 1500;",
        "float    g_pid_kp        = 1.85f;",
        "float    g_pid_ki        = 0.42f;",
        "float    g_pid_kd        = 0.06f;",
        "float    g_setpoint      = 0.0f;",
        "float    g_measured      = 0.0f;",
        "uint16_t g_pwm_duty      = 0;",
        "uint32_t g_uart_tx_count = 0;",
        "uint32_t g_uart_rx_count = 0;",
        "uint32_t g_can_last_id   = 0;",
        "uint32_t g_watchdog_kick = 0;",
        "uint32_t g_heap_used     = 0;",
        "uint32_t g_stack_high_water = 0;",
        "uint32_t g_loop_time_us  = 0;",
        "float    g_control_dt    = 0.001f;",
        "const float g_temp_limit = 85.0f;",
        "bool     g_motor_enabled = true;",
        "uint32_t g_debug_counter = 0;",
        "uint16_t g_adc_samples[16];",
        "imu_sample_t g_imu;",
        "",
        "static PID_HandleTypeDef pid;",
        "static QueueHandle_t sensorQueue;",
        "static osThreadId_t controlTaskHandle;",
        "",
        "/**",
        " * @brief  初始化 ADC、TIM2 PWM 与编码器接口",
        " */",
        "static void Motor_Init(void)",
        "{",
        "    MX_ADC1_Init();",
        "    MX_TIM2_Init();",
        "    HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_1);",
        "    pid_init(&pid, g_pid_kp, g_pid_ki, g_pid_kd, 0.001f);",
        "    g_state = MOTOR_STATE_IDLE;",
        "}",
        "",
        "/**",
        " * @brief  读取母线电压/电流与 NTC 温度",
        " */",
        "static void Sensor_Update(void)",
        "{",
        "    g_bus_voltage = adc_to_voltage(ADC_CH_BUS_V) * 11.0f;",
        "    g_bus_current = adc_to_voltage(ADC_CH_BUS_I) / 0.02f;",
        "    g_sensor_temp = ntc_to_celsius(adc_to_voltage(ADC_CH_NTC));",
        "",
        "    for (uint8_t i = 0; i < 16; i++) {",
        "        g_adc_samples[i] = hadc1.Instance->DR & 0x0FFFu;",
        "    }",
        "",
        "    if (g_sensor_temp > g_temp_limit) {",
        "        g_state = MOTOR_STATE_FAULT;",
        "        g_error_count++;",
        "    }",
        "}",
        "",
        "/**",
        " * @brief  1 kHz 电流环 + 位置环控制任务",
        " */",
        "static void ControlTask(void *argument)",
        "{",
        "    TickType_t lastWake = xTaskGetTickCount();",
        "    (void)argument;",
        "",
        "    Motor_Init();",
        "    for (;;) {",
        "        uint32_t startUs = DWT->CYCCNT;",
        "        Sensor_Update();",
        "",
        "        g_setpoint = (float)g_target_rpm;",
        "        g_measured = encoder_get_rpm() / MOTOR_POLE_PAIRS;",
        "",
        "        /* 断点所在行：EmberProbe 会在这里暂停并显示实时变量 */",
        "        g_motor_rpm = (uint16_t)pid_update(&pid, g_setpoint, g_measured);",
        "",
        "        if (g_motor_enabled && g_state != MOTOR_STATE_FAULT) {",
        "            g_pwm_duty = (uint16_t)fabsf(pid.output) * 2;",
        "            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, g_pwm_duty);",
        "            g_state = MOTOR_STATE_RUNNING;",
        "        } else {",
        "            __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 0);",
        "            g_state = MOTOR_STATE_IDLE;",
        "        }",
        "",
        "        g_imu = imu_read();",
        "        g_watchdog_kick = HAL_GetTick();",
        "        g_loop_time_us = (DWT->CYCCNT - startUs) / (SystemCoreClock / 1000000U);",
        "        g_debug_counter++;",
        "",
        "        vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(CONTROL_PERIOD_MS));",
        "    }",
        "}",
        "",
        "/**",
        " * @brief  5 ms 传感器融合任务",
        " */",
        "static void SensorTask(void *argument)",
        "{",
        "    imu_sample_t sample;",
        "    (void)argument;",
        "",
        "    for (;;) {",
        "        if (imu_data_ready()) {",
        "            sample = imu_read();",
        "            xQueueSend(sensorQueue, &sample, 0);",
        "        }",
        "        vTaskDelay(pdMS_TO_TICKS(SENSOR_PERIOD_MS));",
        "    }",
        "}",
        "",
        "/**",
        " * @brief  20 ms 通信任务：USB-CDC / CAN 遥测",
        " */",
        "static void CommsTask(void *argument)",
        "{",
        "    (void)argument;",
        "    for (;;) {",
        "        telemetry_send(&g_telemetry_frame);",
        "        g_uart_tx_count++;",
        "        if (can_receive(&g_can_last_id, 0)) g_uart_rx_count++;",
        "        vTaskDelay(pdMS_TO_TICKS(COMMS_PERIOD_MS));",
        "    }",
        "}",
        "",
        "int main(void)",
        "{",
        "    HAL_Init();",
        "    SystemClock_Config();",
        "    MX_GPIO_Init();",
        "    MX_USART1_UART_Init();",
        "    MX_CAN1_Init();",
        "    osKernelInitialize();",
        "",
        "    sensorQueue = xQueueCreate(4, sizeof(imu_sample_t));",
        "    controlTaskHandle = osThreadNew(ControlTask, NULL, &controlTaskAttr);",
        "    osThreadNew(SensorTask, NULL, &sensorTaskAttr);",
        "    osThreadNew(CommsTask, NULL, &commsTaskAttr);",
        "    osThreadNew(LoggerTask, NULL, &loggerTaskAttr);",
        "",
        "    osKernelStart();",
        "    for (;;) {",
        "        /* 不应到达这里 */",
        "    }",
        "}"
    ].join("\n");

    var FREERTOS_CONFIG = [
        "#ifndef FREERTOS_CONFIG_H",
        "#define FREERTOS_CONFIG_H",
        "",
        "#define configUSE_PREEMPTION                    1",
        "#define configUSE_IDLE_HOOK                     0",
        "#define configUSE_TICK_HOOK                     0",
        "#define configCPU_CLOCK_HZ                      (SystemCoreClock)",
        "#define configTICK_RATE_HZ                      ((TickType_t)1000)",
        "#define configMAX_PRIORITIES                    (7)",
        "#define configMINIMAL_STACK_SIZE                ((uint16_t)128)",
        "#define configTOTAL_HEAP_SIZE                   ((size_t)(40 * 1024))",
        "#define configUSE_TRACE_FACILITY                1",
        "#define configUSE_STATS_FORMATTING_FUNCTIONS    1",
        "#define configGENERATE_RUN_TIME_STATS           1",
        "",
        "#endif /* FREERTOS_CONFIG_H */"
    ].join("\n");

    var README_MD = [
        "# EmberProbeDemo",
        "",
        "STM32F407ZGTx 无刷电机控制演示工程，用于配合 EmberProbe 扩展进行烧录、调试、",
        "实时变量采样、外设寄存器查看与 FreeRTOS 任务分析。",
        "",
        "## 构建",
        "",
        "```bash",
        "cmake --preset Debug",
        "cmake --build --preset Debug",
        "```",
        "",
        "## 快速开始",
        "",
        "1. 在活动栏中打开 **EmberProbe** 视图。",
        "2. 选择 ELF 与调试器（J-Link），点击 **烧录**。",
        "3. 点击 **调试** 进入 DAP 调试会话。",
        "4. 使用 **实时变量查看** 打开波形面板观察 `g_motor_rpm` 等变量。",
        "",
        "> 本页面是界面复刻演示，所有数据均为模拟值。"
    ].join("\n");

    var FILES = {
        "main.c": { label: "main.c", language: "C", path: "Core/Src/main.c", content: MAIN_C, modified: true },
        "FreeRTOSConfig.h": {
            label: "FreeRTOSConfig.h",
            language: "C",
            path: "Core/Inc/FreeRTOSConfig.h",
            content: FREERTOS_CONFIG,
            modified: false
        },
        "README.md": {
            label: "README.md",
            language: "Markdown",
            path: "README.md",
            content: README_MD,
            modified: false
        }
    };

    var EXPLORER = [
        {
            type: "folder",
            label: ".vscode",
            open: false,
            children: [
                { type: "file", label: "c_cpp_properties.json" },
                { type: "file", label: "tasks.json" }
            ]
        },
        {
            type: "folder",
            label: "Core",
            open: true,
            children: [
                {
                    type: "folder",
                    label: "Inc",
                    open: false,
                    children: [
                        { type: "file", label: "main.h" },
                        { type: "file", label: "FreeRTOSConfig.h" },
                        { type: "file", label: "stm32f4xx_hal_conf.h" },
                        { type: "file", label: "pid.h" },
                        { type: "file", label: "imu.h" }
                    ]
                },
                {
                    type: "folder",
                    label: "Src",
                    open: true,
                    children: [
                        { type: "file", label: "main.c", modified: true },
                        { type: "file", label: "freertos.c", modified: true },
                        { type: "file", label: "stm32f4xx_it.c" },
                        { type: "file", label: "system_stm32f4xx.c" },
                        { type: "file", label: "pid.c" },
                        { type: "file", label: "imu.c" }
                    ]
                }
            ]
        },
        {
            type: "folder",
            label: "Drivers",
            open: false,
            children: [
                {
                    type: "folder",
                    label: "STM32F4xx_HAL_Driver",
                    open: false,
                    children: [
                        { type: "file", label: "stm32f4xx_hal_adc.c" },
                        { type: "file", label: "stm32f4xx_hal_tim.c" }
                    ]
                },
                {
                    type: "folder",
                    label: "CMSIS",
                    open: false,
                    children: [
                        { type: "file", label: "core_cm4.h" },
                        { type: "file", label: "stm32f407xx.h" }
                    ]
                }
            ]
        },
        {
            type: "folder",
            label: "Middlewares",
            open: false,
            children: [
                {
                    type: "folder",
                    label: "Third_Party",
                    open: false,
                    children: [
                        {
                            type: "folder",
                            label: "FreeRTOS",
                            open: false,
                            children: [
                                { type: "file", label: "tasks.c" },
                                { type: "file", label: "queue.c" }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            type: "folder",
            label: "build",
            open: false,
            children: [
                {
                    type: "folder",
                    label: "Debug",
                    open: false,
                    children: [
                        { type: "file", label: "EmberProbeDemo.elf" },
                        { type: "file", label: "EmberProbeDemo.map" },
                        { type: "file", label: "EmberProbeDemo.bin" }
                    ]
                }
            ]
        },
        { type: "file", label: ".mxproject" },
        { type: "file", label: "EmberProbeDemo.ioc" },
        { type: "file", label: "README.md" }
    ];

    var SEARCH_RESULTS = [
        {
            file: "Core/Src/main.c",
            matches: [
                { line: 24, text: "uint16_t g_motor_rpm     = 0;" },
                { line: 87, text: "g_motor_rpm = (uint16_t)pid_update(&pid, g_setpoint, g_measured);" },
                { line: 110, text: "g_measured = encoder_get_rpm() / MOTOR_POLE_PAIRS;" }
            ]
        },
        {
            file: "Core/Src/pid.c",
            matches: [
                { line: 41, text: "float pid_update(PID_HandleTypeDef *h, float setpoint, float measured)" },
                { line: 58, text: "h->integral += h->ki * h->error * h->dt;" }
            ]
        },
        {
            file: "Core/Inc/pid.h",
            matches: [{ line: 18, text: "float pid_update(PID_HandleTypeDef *h, float setpoint, float measured);" }]
        }
    ];

    var SCM_CHANGES = [
        { label: "Core/Src/main.c", status: "M", folder: "Core/Src" },
        { label: "Core/Src/freertos.c", status: "M", folder: "Core/Src" },
        { label: "Core/Src/pid.c", status: "U", folder: "Core/Src" },
        { label: "Core/Inc/pid.h", status: "U", folder: "Core/Inc" }
    ];

    var BREAKPOINTS = [{ file: "main.c", line: 103, enabled: true }];

    var PROBLEMS = [
        { severity: "warning", file: "main.c", line: 47, message: '未使用的变量 "g_debug_counter"', source: "clangd" },
        {
            severity: "warning",
            file: "main.c",
            line: 74,
            message: "隐式转换可能丢失精度: double -> float",
            source: "clangd"
        }
    ];

    var COMMANDS = [
        { id: "workbench.action.selectTheme", title: "颜色主题", category: "首选项", action: "theme" },
        { id: "mockup.theme.light", title: "浅色现代 · Light Modern", category: "颜色主题", action: "theme:light" },
        { id: "mockup.theme.dark", title: "深色现代 · Dark Modern", category: "颜色主题", action: "theme:dark" },
        { id: "mcu-vscode.debug", title: "启动调试", category: "EmberProbe", action: "debug", key: "F5" },
        { id: "mcu-vscode.download", title: "下载程序", category: "EmberProbe", action: "download" },
        { id: "mcu-vscode.openLiveWatch", title: "实时变量查看", category: "EmberProbe", action: "livewatch" },
        {
            id: "mcu-vscode.checkOpenOcd",
            title: "检查 OpenOCD 环境",
            category: "EmberProbe",
            action: "toast:OpenOCD 0.12.0 可用（J-Link · SWD 2000 kHz）"
        },
        {
            id: "mcu-vscode.manageAgentSkills",
            title: "管理 Agent Skills",
            category: "EmberProbe",
            action: "command:mcu-vscode.manageAgentSkills"
        },
        {
            id: "mcu-vscode.downloadOfficialSvd",
            title: "下载/配置官方 SVD",
            category: "EmberProbe",
            action: "command:mcu-vscode.downloadOfficialSvd"
        },
        {
            id: "workbench.view.emberprobe",
            title: "显示 EmberProbe (Flash & Debug)",
            category: "视图",
            action: "view:emberprobe"
        },
        {
            id: "workbench.action.terminal.toggle",
            title: "切换终端",
            category: "视图",
            action: "panel:terminal",
            key: "Ctrl+`"
        },
        {
            id: "workbench.action.toggleSidebar",
            title: "切换主侧边栏",
            category: "视图",
            action: "toggleSidebar",
            key: "Ctrl+B"
        },
        {
            id: "workbench.action.togglePanel",
            title: "切换面板",
            category: "视图",
            action: "togglePanel",
            key: "Ctrl+J"
        },
        { id: "debug.continue", title: "继续", category: "调试", action: "resume", key: "F5" },
        { id: "debug.pause", title: "暂停", category: "调试", action: "pause", key: "F6" },
        { id: "debug.stepOver", title: "单步跳过", category: "调试", action: "step", key: "F10" },
        { id: "debug.stepInto", title: "单步调试", category: "调试", action: "step", key: "F11" },
        { id: "debug.stop", title: "停止", category: "调试", action: "stopDebug", key: "Shift+F5" },
        { id: "workbench.action.reloadWindow", title: "重新加载窗口", category: "开发者", action: "reload" }
    ];

    return {
        BREAKPOINTS: BREAKPOINTS,
        FILES: FILES,
        EXPLORER: EXPLORER,
        SEARCH_RESULTS: SEARCH_RESULTS,
        SCM_CHANGES: SCM_CHANGES,
        PROBLEMS: PROBLEMS,
        COMMANDS: COMMANDS
    };
});
