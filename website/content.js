"use strict";

const { publisher, name } = require("../package.json");

const repository = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug";
const extensionId = `${publisher}.${name}`;

const links = {
    github: repository,
    install: `vscode:extension/${extensionId}`,
    marketplace: `https://marketplace.visualstudio.com/items?itemName=${extensionId}`,
    docs: `${repository}/blob/master/docs/guide/getting-started.md`,
    docsEn: `${repository}/blob/master/README_EN.md`
};

// Representative series with matching scripts in the bundled OpenOCD.
const chipVendors = [
    [
        "STMicroelectronics",
        "STM32",
        [
            "STM32C0/C5",
            "STM32F0/F1/F2/F3/F4/F7",
            "STM32G0/G4",
            "STM32H7",
            "STM32L0/L1/L4/L5",
            "STM32U0/U3/U5",
            "STM32WB/WBA/WL",
            "STM32MP13/MP15"
        ]
    ],
    [
        "GigaDevice",
        "GD32",
        ["GD32F101/F103", "GD32F130/F150", "GD32F303", "GD32F310/F330/F350", "GD32E23x", "GD32VF103"]
    ],
    ["Geehy", "APM32", ["APM32E030/E103", "APM32F0x/F1x/F4x"]],
    ["Artery", "AT32", ["AT32F403A/F407/F407A", "AT32F413/F415", "AT32F421/F423/F425", "AT32F435/F437", "AT32WB415"]],
    ["WCH", "CH32", ["CH32F103"]],
    ["Raspberry Pi", "RP", ["RP2040", "RP2350"]],
    ["Nordic Semiconductor", "nRF", ["nRF51", "nRF52"]],
    ["Nuvoton", "NuMicro", ["NuMicro M0", "NuMicro M4"]]
];

const agentClients = [
    ["claudecode", "Claude Code"],
    ["codex", "Codex"],
    ["geminicli", "Gemini CLI"],
    ["opencode", "OpenCode"],
    ["githubcopilot", "GitHub Copilot"],
    ["cursor", "Cursor"],
    ["antigravity", "Antigravity"],
    ["deepseek", "DeepSeek Harness"],
    ["workbuddy", "WorkBuddy"]
];

const mcpTools = {
    config: ["config_get", "config_set", "probe_list", "probe_select"],
    target: ["chip_read", "target_control", "fault_read"],
    flash: ["flash_program", "flash_verify"],
    variables: ["variables_list", "variables_read", "variables_write"],
    watch: ["watch_add", "watch_list", "watch_remove"],
    sampling: ["variables_sample", "sampling_status", "sampling_control", "variables_export_csv"],
    debug: ["debug_status", "debug_select", "debug_start", "debug_control"],
    inspect: ["debug_inspect", "debug_evaluate", "memory_read", "debug_breakpoints_list", "debug_breakpoints_update"],
    rtos: ["rtos_status", "rtos_snapshot"],
    peripherals: ["peripherals_list", "peripherals_read", "peripherals_write"],
    rtt: ["rtt_status", "rtt_read", "rtt_control", "rtt_write"],
    elf: ["elf_analyze"],
    cubemx: [
        "cubemx_detect",
        "cubemx_inspect",
        "cubemx_query",
        "cubemx_candidate",
        "cubemx_check",
        "cubemx_prepare",
        "cubemx_start",
        "cubemx_execute",
        "cubemx_status",
        "cubemx_cancel"
    ],
    permission: ["permission_get", "permission_reset"]
};

// Copy says what the visitor gets, not how to operate it or how it works; facts still follow docs/guide/.
// `chapters` runs in the order of use. A chapter's id defaults to its recording in website/capture/scenes.js.
const content = {
    zh: {
        htmlLang: "zh-CN",
        title: "EmberProbe：Agent 友好的现代化 STM32 调试插件",
        description:
            "在 VS Code 中一键烧录和调试 STM32，非侵入地实时读写变量、绘制波形，并通过 MCP 让 Agent 直接操作硬件。",
        skip: "跳到正文",
        language: "English",
        navLabel: "主导航",
        projectLabel: "项目链接",
        subtitle: "Agent 友好的现代化 STM32 调试插件",
        install: "安装到 VS Code",
        marketplace: "在网页中查看",
        installTitle: "安装到 VS Code · EmberProbe",
        installDescription: "安装 EmberProbe 扩展，自动打开 VS Code 插件界面。",
        installHeading: "正在打开 VS Code",
        installLead: "正在打开 VS Code 中的 EmberProbe 扩展，不能自动打开时可点击按钮继续。",
        installCommandHint: "也可在 VS Code 中输入命令安装：",
        tour: "打开引导教程",
        heroAlt: "EmberProbe 界面：侧栏实时读写 C++ 变量，波形图显示 PID 成员与采样历史",
        player: { pause: "暂停", play: "播放", enlarge: "放大", exit: "退出放大" },
        chapters: [
            {
                id: "config",
                nav: "配置",
                title: "一键配置，何须 launch.json",
                lead: "插上 Link、打开工程，自动识别固件，完成调试器和芯片配置。",
                alt: "点击自动检测配置后填入固件和脚本，刷新探针列表显示内核型号，再选择探针",
                support: {
                    title: "基于OpenOCD的强大兼容能力",
                    probes: {
                        label: "调试器",
                        items: [
                            "J-Link",
                            "ST-Link",
                            "CMSIS-DAP",
                            "DAPLink",
                            "XDS110",
                            "Nu-Link",
                            "TI-ICDI",
                            "FTDI",
                            "KitProg"
                        ]
                    },
                    chips: "支持的芯片系列",
                    systems: { label: "操作系统", items: ["Windows", "Linux", "macOS"] },
                    note: "还可使用其他 OpenOCD 接口脚本。"
                }
            },
            {
                id: "flash",
                nav: "烧录",
                title: "一键烧录，自动提速",
                lead: "编译烧录一气呵成",
                alt: "点击烧录后，侧栏显示当前阶段，终端输出烧录日志和摘要"
            },
            {
                id: "debug",
                nav: "调试",
                title: "集成断点调试",
                lead: "内置调试器，断点、单步、调用栈、变量和寄存器一应俱全。",
                alt: "设置断点后复位调试，停在 main，继续运行命中断点并单步，停止后用不复位调试附加到目标",
                points: [
                    ["工具链自动寻找", "自动找到本机的 ARM GDB 工具链，装过 STM32CubeIDE 或 CubeCLT 即可直接调试。"],
                    ["复位调试", "下载最新固件，从头运行并停在 main。"],
                    ["不复位调试", "直接接入正在运行的板子，保留现场，不改动 Flash。"],
                    ["原生 VS Code 调试体验", "熟悉的调试工具栏、变量与调用栈视图，调试控制台直接输入 GDB 命令。"]
                ]
            },
            {
                id: "sampling",
                nav: "采样",
                zone: {
                    title: "实时采样与波形",

                    stats: [
                        ["不限速", "至高达2000+Hz"],
                        ["C / C++", "全类型解析"],
                        ["非侵入", "运行时读取变量"],
                        ["零代码", "不改固件，不打断程序"]
                    ],
                    modes: {
                        id: "sampling-modes",
                        title: "侧栏与波形窗口，按需选择",
                        lead: "随手看一眼用侧栏，细看和留存用波形窗口。",
                        cards: [
                            {
                                kind: "sidebar",
                                name: "侧栏观测",
                                fit: "时效要求低 · 无需导出",
                                rate: "20 Hz",
                                rateNote: "固定频率，只显示当前值",
                                shot: "mode-sidebar",
                                alt: "侧栏实时读写：查看列表显示 g_sensor_temp、g_motor_rpm、g_bus_voltage 的当前值，写入列表可调 g_target_rpm 和 g_pid_kp",
                                facts: [
                                    ["数据", "当前数值", "实时读写，写后自动回读"],
                                    ["记录", "即时观测", "结构体展开才读，折叠即停"],
                                    ["窗口", "侧栏常驻", "与调试器并排，无需切换"]
                                ]
                            },
                            {
                                kind: "chart",
                                name: "波形图采样",
                                fit: "时效要求高 · 需要导出",
                                rate: "不限速",
                                rateNote: "采样率自定义，整段历史保留",
                                shot: "mode-chart",
                                alt: "波形窗口：左侧是三个变量的当前值，右侧是归一化后的历史曲线和时间轴",
                                facts: [
                                    ["数据", "实时曲线", "当前值与历史波形同时看"],
                                    ["记录", "完整历史", "任选变量和时间段导出 CSV"],
                                    ["窗口", "独立波形窗口", "多个窗口，各自独立"]
                                ]
                            }
                        ],
                        silent: {
                            title: "静默采样",
                            scope: "仅波形窗口",
                            text: "隐藏的曲线和结构体成员照常记录，重新显示即可看到隐藏期间的历史。",
                            steps: ["隐藏曲线", "持续记录", "CSV 导出"]
                        }
                    },
                    states: {
                        id: "sampling-states",
                        title: "全场景采样",
                        lead: "不开调试、调试运行、断点暂停，三种状态都能采样。",
                        items: [
                            {
                                id: "sampling-standalone",
                                name: "独立运行",
                                tag: "不限速",
                                text: "不开调试也能持续采样，可选不限速，速度只取决于探针。",
                                alt: "在波形窗口把采样率拖到不限速，开始采样后曲线持续绘制"
                            },
                            {
                                id: "sampling-debug",
                                name: "调试运行中",
                                tag: "按设定频率",
                                text: "边调试边看曲线。调试启动时采样暂停，程序继续运行后按设定频率接着采。",
                                alt: "采样中用不复位调试附加到目标，采样暂停；点继续运行后曲线恢复绘制"
                            },
                            {
                                id: "sampling-break",
                                name: "断点暂停时",
                                tag: "每停一次读一组",
                                text: "每次命中断点或单步停下，都读取一组当前值，配合单步观察变量变化。",
                                alt: "命中断点后单步执行，侧栏数值随每次停下刷新；回到波形窗口，每次停下对应一个采样点"
                            }
                        ]
                    },
                    types: {
                        id: "variables",
                        title: "查看 C/C++ 变量",
                        lead: "从固件的调试信息自动解析地址和类型，按名称搜索即可添加。同名 static 变量会标出来源文件。",
                        gallery: [
                            {
                                id: "type-basic",
                                name: "基本类型",
                                text: "整数、浮点、布尔和 const 常量，按声明的类型读取，直接显示数值。",
                                alt: "侧栏查看列表：g_sensor_temp、g_motor_rpm、g_error_count、g_motor_enabled、g_temp_limit 及其类型和数值"
                            },
                            {
                                id: "type-struct",
                                name: "结构体与数组",
                                text: "结构体、数组和结构体数组逐层展开，每个成员都标出类型和数值。",
                                alt: "侧栏中展开的 g_imu 结构体和 g_sensors 结构体数组，显示各成员的类型和数值"
                            },
                            {
                                id: "type-enum",
                                name: "枚举",
                                text: "自动读取枚举定义，显示成员名加数值。带作用域的成员和同值成员也能读懂。",
                                alt: "侧栏中 g_motor_mode 显示 MODE_RUN(1)，g_app_state 显示 .Active / .Ready(3)"
                            },
                            {
                                id: "type-pointer",
                                name: "指针解引用与 C++ 引用",
                                text: "侧栏和波形窗口可逐层展开数据指针。C++ 引用直接显示目标值或成员。函数指针显示函数名，字符串指针可直接查看文本。",
                                alt: "侧栏中 g_active_sensor 展开为 g_sensors[1] 的成员，C++ 引用 g_target_rpm_ref 直接显示目标转速"
                            },
                            {
                                id: "type-class",
                                name: "C++ 类与标准库",
                                text: "类成员、std::atomic、unique_ptr、std::function 各显示为一行，编译器和标准库的内部成员默认隐藏。",
                                alt: "侧栏中展开的 app::Motor 对象 g_motor，显示 name、state、speed、driver、on_fault，并提示已隐藏 2 个内部成员"
                            },
                            {
                                id: "type-stl",
                                name: "STL 容器",
                                text: "在 EmberProbe 查看列表中展开 vector 等容器，实时读出元素及当前值。optional 的值也可直接查看。",
                                alt: "EmberProbe 侧栏查看列表中，g_rpm_history 的 vector 展开三个元素，g_speed_limit 的 optional 显示当前值"
                            }
                        ]
                    },
                    chart: {
                        id: "waveform",
                        title: "完整的绘图工具",
                        lead: "把变量画成实时曲线，看、比、存一应俱全。",
                        alt: "把采样率调到不限速，冻结图表，拖动历史时间轴，再选择曲线和范围导出 CSV",
                        features: [
                            ["缩放与归一化", "切换时间窗口，一键归一化，量级不同的曲线放在一起比较。"],
                            ["多个波形窗口", "每个窗口有独立的变量列表和历史，重启后自动恢复。"],
                            ["DEC / HEX / BIN", "按变量切换显示进制，不影响采样和导出。"],
                            ["临时增益", "给曲线乘上倍数，小信号也能看清。"],
                            ["大容量历史", "默认 512 MiB 内存加 1 GiB 磁盘归档，长时间采样不丢数据。"],
                            ["自由导出 CSV", "任选变量和时间段导出原始采样点，包括早已移出内存的历史。"]
                        ],
                        shots: [
                            {
                                id: "chart-menu",

                                alt: "波形窗口中 g_motor_rpm 的右键菜单，含类型、进制 DEC/HEX/BIN、增益和曲线样式"
                            },
                            {
                                id: "chart-export",

                                alt: "导出 CSV 对话框，勾选三条曲线并选择时间范围"
                            }
                        ]
                    }
                }
            },
            {
                id: "write",
                clip: "variables",
                nav: "写入",
                title: "实时写入变量，自动回读",
                lead: "实时写入变量，支持静态变量与动态成员。无需任何代码，更不用反复烧录",
                alt: "侧栏搜索 g_target_rpm 并加入查看和写入列表，把目标转速改为 2400，观察实际转速上升",
                points: [
                    ["变量与对象成员", "输入新值或拖动滑块，调整全局变量和可写成员。"],
                    ["运行时定位", "可写入指针所指对象、链表节点和部分容器的标量成员。"],
                    ["回读确认", "写入前复核目标，写入后回读。动态目标的地址或类型变化时，对应的写入项会停用。"]
                ],
                shot: {
                    id: "write-member",
                    alt: "侧栏写入列表中，已修改 g_active_sensor 指向的对象成员并显示回读结果"
                }
            },
            {
                id: "agent",
                nav: "Agent",
                title: "赋予 Agent 强大能力",
                lead: "内置 MCP 服务器，Agent 可以帮你烧录、读写变量、调试、查看外设和生成 CubeMX 代码。",
                alt: "在侧栏为 Gemini CLI 安装 MCP 服务器，升级 Codex 配置，再查看完全允许 Agent 操作开关",
                points: [
                    ["MCP 一键接入", "在侧栏为常用 Agent 客户端安装 MCP，检测连接并查看工具数量。"],
                    ["敏感操作请求", "烧录、写入等操作先给出计划，你在对话中确认后才执行。"],
                    ["Skills 兼容", "附带现成的工作流 Skills，Agent 按成熟流程操作硬件。"]
                ]
            }
        ],
        agent: {
            clientsTitle: "支持的 Agent 客户端",
            capabilitiesTitle: "MCP 能力",
            capabilities: [
                ["config", "工程配置", "读取与更新工程配置，列出并选择已连接的调试器。"],
                ["target", "芯片与运行状态", "读取芯片信息与故障现场，独立暂停、继续或复位目标。"],
                ["flash", "固件烧录与校验", "烧录 ELF 固件、校验 Flash 内容，并复位运行。"],
                ["variables", "变量读写", "搜索全局与静态变量，通过 C++ 引用或指针读取成员，写入可写标量并回读。"],
                ["watch", "观测列表", "添加、查看或移除侧栏与波形窗口中的观测变量。"],
                ["sampling", "实时采样与导出", "多次读取变量、控制持续采样，并将波形历史导出为工作区 CSV 文件。"],
                ["debug", "调试控制", "查看和选择会话，启动或附加调试，暂停、继续、单步、重启与停止。"],
                ["inspect", "断点与现场查看", "管理断点与数据断点，暂停时查看线程、调用栈、变量与原始内存。"],
                ["rtos", "FreeRTOS 任务", "查看 RTOS 支持状态，暂停时读取任务状态、优先级与栈使用。"],
                ["peripherals", "外设寄存器", "按 SVD 搜索外设、寄存器与位域，读取或写入数值。"],
                ["rtt", "RTT 日志", "启动或停止 RTT，查看连接状态，读取固件输出，你确认后向固件输入命令。"],
                ["elf", "内存占用", "分析 ELF 的 Flash、RAM、内存区域、段与大符号占用。"],
                [
                    "cubemx",
                    "CubeMX 代码生成",
                    "查看与检查工程，准备配置改动并生成代码，跟踪或取消操作；支持 .ioc 与 .ioc2。"
                ],
                ["permission", "操作权限", "查看或清除已记住的工程授权与待确认请求。"]
            ],
            groups: [
                [
                    "setup",
                    "连接与配置",
                    "从识别调试器到检查芯片和内存，为操作做好准备。",
                    ["config", "target", "elf", "permission"]
                ],
                ["flash", "烧录与校验", "把固件写入目标芯片，校验结果，再复位运行。", ["flash"]],
                ["watch", "变量与波形", "读写变量、持续采样，回看波形并导出记录。", ["variables", "watch", "sampling"]],
                ["debug", "断点与调试", "控制程序执行，查看断点现场与 FreeRTOS 任务。", ["debug", "inspect", "rtos"]],
                ["peripherals", "外设与日志", "查看和修改外设寄存器，通过 RTT 读取固件输出。", ["peripherals", "rtt"]],
                ["cubemx", "CubeMX 代码生成", "检查工程、准备配置改动，并跟踪代码生成。", ["cubemx"]]
            ],
            toolsLabel: "MCP 工具",
            detailsLabel: "查看工具明细"
        },
        tools: {
            id: "tools",
            nav: "工具",
            title: "更多工具",
            lead: "侧栏里的其他实用工具。",
            items: [
                {
                    id: "peripheral",
                    title: "外设寄存器",
                    lead: "按 SVD 查看和修改外设寄存器与位域，数值实时刷新。",
                    alt: "展开 TIM2 外设，寄存器值持续刷新，再展开 CR1 查看位域"
                },
                {
                    id: "rtos",
                    title: "FreeRTOS 任务",
                    lead: "一眼看清每个任务的状态、优先级和栈使用。",
                    alt: "调试暂停时刷新任务表，再展开 ControlTask 查看详情"
                },
                {
                    id: "memory",
                    title: "内存占用",
                    lead: "FLASH、RAM 和各内存区域用了多少，一目了然。",
                    alt: "刷新内存占用，显示 FLASH、RAM 和 CCMRAM 的用量"
                },
                {
                    id: "chip",
                    title: "芯片信息",
                    lead: "内核、器件 ID、Flash 容量和唯一 ID，一键读取。",
                    alt: "读取芯片信息，展开详情查看器件 ID、唯一 ID 和调试连接"
                },
                {
                    id: "rtt",
                    title: "RTT 日志",
                    lead: "固件日志实时显示在 VS Code 面板，可向固件发送命令，也能一键保存到文件。",
                    alt: "在侧栏启动 RTT，底部的 RTT 终端持续显示固件日志；开启保存日志后，在输入框发送 status 命令并收到固件回应"
                }
            ]
        },
        source: "源代码",
        releases: "版本更新",
        issues: "问题反馈",
        license: "MIT 许可证",
        demoTitle: "EmberProbe 引导教程",
        simulation: "模拟环境，不连接硬件",
        back: "返回官网",
        reset: "重新开始",
        tourTitle: "引导教程",
        tourExit: "退出教程",
        tourResume: "继续教程",
        tourPreparing: "正在准备模拟环境",
        tourSkip: "跳过此步",
        tourNext: "下一步",
        tourNextChapter: "下一章",
        tourChapterDone: "本章完成。",
        tourAllDone: "全部章节已完成。退出教程后可以继续在编辑器中操作。",
        mobileHint: "引导教程需要 900 像素以上的窗口宽度。",
        mobileLink: "在首页查看操作录屏",
        noScript: "引导教程需要启用 JavaScript。"
    },
    en: {
        htmlLang: "en",
        title: "EmberProbe: the modern, Agent-friendly STM32 debugger",
        description:
            "Flash and debug STM32 in VS Code with one click, read and write variables live without stopping the target, plot waveforms, and let Agents work with your hardware through MCP.",
        skip: "Skip to content",
        language: "中文",
        navLabel: "Main navigation",
        projectLabel: "Project links",
        subtitle: "The modern, Agent-friendly STM32 debugging extension",
        install: "Install in VS Code",
        marketplace: "View in Marketplace",
        installTitle: "Install in VS Code · EmberProbe",
        installDescription: "Install the EmberProbe extension by opening its Marketplace page directly in VS Code.",
        installHeading: "Opening VS Code",
        installLead: "Opening EmberProbe in VS Code. If it does not open automatically, use the buttons below.",
        installCommandHint: "Or run in VS Code Quick Open (Ctrl+P):",
        tour: "Open the guided tour",
        heroAlt:
            "EmberProbe: live C++ variable reads and writes in the sidebar, with PID members and sampling history in the waveform view",
        player: { pause: "Pause", play: "Play", enlarge: "Enlarge", exit: "Exit enlarged view" },
        chapters: [
            {
                id: "config",
                nav: "Setup",
                title: "One-click setup. No launch.json.",
                lead: "Plug in your probe and open the project. EmberProbe finds the firmware and sets up the debugger and chip for you.",
                alt: "Auto-detect fills in the firmware and scripts, a refresh shows each probe's core, then a probe is selected",
                support: {
                    title: "Broad compatibility powered by OpenOCD",
                    probes: {
                        label: "Debug probes",
                        items: [
                            "J-Link",
                            "ST-Link",
                            "CMSIS-DAP",
                            "DAPLink",
                            "XDS110",
                            "Nu-Link",
                            "TI-ICDI",
                            "FTDI",
                            "KitProg"
                        ]
                    },
                    chips: "Supported chip families",
                    systems: { label: "Operating systems", items: ["Windows", "Linux", "macOS"] },
                    note: "Additional OpenOCD interface scripts can be used."
                }
            },
            {
                id: "flash",
                nav: "Flash",
                title: "One-click flashing, automatically faster",
                lead: "Build and flash in one smooth flow.",
                alt: "After Flash is clicked, the sidebar shows the current stage and the terminal shows the log and a summary"
            },
            {
                id: "debug",
                nav: "Debug",
                title: "Built-in breakpoint debugging",
                lead: "A built-in debugger with breakpoints, stepping, call stack, variables, and registers.",
                alt: "A breakpoint is set, reset debugging stops at main, Continue reaches the breakpoint, then stepping, stopping, and attaching without a reset",
                points: [
                    [
                        "Finds your toolchain",
                        "Locates the ARM GDB toolchain on your machine. With STM32CubeIDE or CubeCLT installed, just start debugging."
                    ],
                    ["Debug with reset", "Downloads the latest firmware, runs from the start, and stops at main."],
                    [
                        "Debug without reset",
                        "Attaches to the running board and keeps its state, without touching Flash."
                    ],
                    [
                        "Native VS Code debugging",
                        "The familiar debug toolbar, variable and call stack views, and a debug console that takes GDB commands."
                    ]
                ]
            },
            {
                id: "sampling",
                nav: "Sampling",
                zone: {
                    title: "Live sampling and waveforms",

                    stats: [
                        ["Unlimited", "Up to 2000+ Hz"],
                        ["C / C++", "Every type parsed"],
                        ["Non-intrusive", "Read variables while running"],
                        ["Zero code", "No firmware changes, no pauses"]
                    ],
                    modes: {
                        id: "sampling-modes",
                        title: "Sidebar or waveform window, as the job needs",
                        lead: "Glance at values in the sidebar; study and keep them in the waveform window.",
                        cards: [
                            {
                                kind: "sidebar",
                                name: "Sidebar watch",
                                fit: "Low time resolution · No export",
                                rate: "20 Hz",
                                rateNote: "Fixed rate, current values only",
                                shot: "mode-sidebar",
                                alt: "Sidebar live read and write: the watch list shows current values of g_sensor_temp, g_motor_rpm and g_bus_voltage, and the write list adjusts g_target_rpm and g_pid_kp",
                                facts: [
                                    ["Data", "Current values", "Live reads and writes, with readback"],
                                    ["History", "Live view only", "Read structs while open; stop when folded"],
                                    ["Window", "In the sidebar", "Beside the debugger, no switching"]
                                ]
                            },
                            {
                                kind: "chart",
                                name: "Waveform sampling",
                                fit: "High time resolution · Export needed",
                                rate: "Unlimited",
                                rateNote: "Any sample rate you set, full history kept",
                                shot: "mode-chart",
                                alt: "Waveform window: current values of three variables on the left, normalized history curves and a timeline on the right",
                                facts: [
                                    ["Data", "Live curves", "Current values and history together"],
                                    ["History", "Full recording", "Export any variables and time range as CSV"],
                                    ["Window", "Separate charts", "Several windows, each independent"]
                                ]
                            }
                        ],
                        silent: {
                            title: "Silent sampling",
                            scope: "Waveform window",
                            text: "Hidden curves and struct members keep recording. Show them again to see the history you missed.",
                            steps: ["Hide curves", "Keep recording", "Export CSV"]
                        }
                    },
                    states: {
                        id: "sampling-states",
                        title: "Sampling in every state",
                        lead: "Without a debugger, while debugging, at a breakpoint: all three states sample.",
                        items: [
                            {
                                id: "sampling-standalone",
                                name: "Standalone",
                                tag: "Unlimited",
                                text: "Sample continuously without a debug session, unlimited if you like, as fast as the probe allows.",
                                alt: "The waveform window's sample rate is dragged to unlimited, sampling starts and the curves keep drawing"
                            },
                            {
                                id: "sampling-debug",
                                name: "While debugging",
                                tag: "At your set rate",
                                text: "Watch curves as you debug. Sampling pauses as debugging starts and resumes at your set rate once the program runs.",
                                alt: "During sampling the debugger attaches without reset and sampling pauses; after Continue the curves draw again"
                            },
                            {
                                id: "sampling-break",
                                name: "At a breakpoint",
                                tag: "One set per stop",
                                text: "Every breakpoint hit or step reads one set of current values, so you can follow changes step by step.",
                                alt: "A breakpoint is hit and stepped over, the sidebar values refresh at each stop, and back in the waveform window each stop is one sample"
                            }
                        ]
                    },
                    types: {
                        id: "variables",
                        title: "Inspect C/C++ variables",
                        lead: "Search variables by name using the firmware's debug information. Static variables with the same name show their source files.",
                        gallery: [
                            {
                                id: "type-basic",
                                name: "Basic types",
                                text: "Integers, floats, booleans and const values are read by their declared type and shown as plain numbers.",
                                alt: "Sidebar watch list: g_sensor_temp, g_motor_rpm, g_error_count, g_motor_enabled and g_temp_limit with their types and values"
                            },
                            {
                                id: "type-struct",
                                name: "Structs and arrays",
                                text: "Structs, arrays and arrays of structs open level by level, with each member's type and value.",
                                alt: "The g_imu struct and the g_sensors array of structs open in the sidebar, showing each member's type and value"
                            },
                            {
                                id: "type-enum",
                                name: "Enums",
                                text: "Enum definitions are read automatically and shown as member name plus value, including scoped and same-valued members.",
                                alt: "In the sidebar, g_motor_mode shows MODE_RUN(1) and g_app_state shows .Active / .Ready(3)"
                            },
                            {
                                id: "type-pointer",
                                name: "Pointer dereferencing and C++ references",
                                text: "Expand data pointers one level at a time in the sidebar or waveform window. C++ references show their target values or members directly. Function pointers show names, and string pointers preview text.",
                                alt: "The sidebar expands g_active_sensor into the fields of g_sensors[1] and shows the target speed directly through g_target_rpm_ref"
                            },
                            {
                                id: "type-class",
                                name: "C++ classes and std",
                                text: "Class members, std::atomic, unique_ptr and std::function each read as one row. Compiler and library internals are hidden by default.",
                                alt: "The app::Motor object g_motor open in the sidebar, showing name, state, speed, driver and on_fault, with 2 internal members hidden"
                            },
                            {
                                id: "type-stl",
                                name: "STL containers",
                                text: "Expand vectors and other supported containers in the EmberProbe watch list to see their elements live. Inspect the current value of an optional directly.",
                                alt: "The EmberProbe sidebar watch list expands three vector elements in g_rpm_history and shows the current optional value in g_speed_limit"
                            }
                        ]
                    },
                    chart: {
                        id: "waveform",
                        title: "A complete plotting toolkit",
                        lead: "Plot variables as live curves, with everything you need to read, compare and keep them.",
                        alt: "The sample rate is set to unlimited, the chart is frozen, the history timeline is dragged, and curves and a range are chosen for CSV export",
                        features: [
                            [
                                "Zoom and normalize",
                                "Switch time windows and normalize in one click to compare curves of any scale."
                            ],
                            [
                                "Multiple windows",
                                "Each waveform window keeps its own variables and history, restored after a restart."
                            ],
                            [
                                "DEC / HEX / BIN",
                                "Change a variable's display base without touching sampling or export."
                            ],
                            ["Temporary gain", "Scale a curve so small signals stay readable."],
                            [
                                "Large history",
                                "512 MiB in memory plus a 1 GiB disk archive by default, so long runs lose nothing."
                            ],
                            [
                                "Export CSV freely",
                                "Export raw samples for any variables and time range, including history long gone from memory."
                            ]
                        ],
                        shots: [
                            {
                                id: "chart-menu",

                                alt: "The right-click menu for g_motor_rpm in the waveform window, with type, DEC/HEX/BIN base, gain and curve style"
                            },
                            {
                                id: "chart-export",

                                alt: "The CSV export dialog with three curves selected and a time range"
                            }
                        ]
                    }
                }
            },
            {
                id: "write",
                clip: "variables",
                nav: "Write",
                title: "Write live values and verify by reading back",
                lead: "Write static variables and dynamic members live, without changing code or reflashing firmware.",
                alt: "The sidebar adds g_target_rpm to the watch and write lists, sets it to 2400 and shows the measured speed rising",
                points: [
                    [
                        "Variables and object members",
                        "Enter a value or drag a slider to tune writable globals and members."
                    ],
                    [
                        "Find members at runtime",
                        "Write to mutable scalars reached through pointers, linked lists and supported containers."
                    ],
                    [
                        "Read-back verification",
                        "EmberProbe checks the target before writing and reads it back afterward. The write card is disabled if a dynamic target's address or type changes."
                    ]
                ],
                shot: {
                    id: "write-member",
                    alt: "The sidebar Write list shows a changed member of the object pointed to by g_active_sensor and the value read back"
                }
            },
            {
                id: "agent",
                nav: "Agent",
                title: "Give your Agent real power",
                lead: "A built-in MCP server lets Agents flash, read and write variables, debug, inspect peripherals, and generate CubeMX code for you.",
                alt: "The MCP server is installed for Gemini CLI in the sidebar, the Codex configuration is upgraded, and the Allow all Agent operations switch is shown",
                points: [
                    [
                        "One-click MCP setup",
                        "Install MCP for popular Agent clients from the sidebar, then check the connection and tool count."
                    ],
                    [
                        "Sensitive operations ask first",
                        "Flashing and writes come with a plan you confirm in the conversation before anything runs."
                    ],
                    ["Works with Skills", "Ready-made workflow Skills let Agents operate the hardware the proven way."]
                ]
            }
        ],
        agent: {
            clientsTitle: "Supported Agent clients",
            capabilitiesTitle: "MCP capabilities",
            capabilities: [
                [
                    "config",
                    "Workspace setup",
                    "Read and update workspace settings, and list or select connected debug probes."
                ],
                [
                    "target",
                    "Chip and target state",
                    "Read chip identity and fault state; halt, resume, or reset outside a debug session."
                ],
                ["flash", "Flash and verify", "Program ELF firmware, verify Flash contents, then reset and run."],
                [
                    "variables",
                    "Variable access",
                    "Find global and static variables, read members through C++ references or pointers, and write mutable scalars with readback."
                ],
                ["watch", "Watch lists", "Add, list, or remove watched variables in the sidebar and live charts."],
                [
                    "sampling",
                    "Sampling and export",
                    "Capture repeated reads, control persistent sampling, and export chart history to a CSV file in the workspace."
                ],
                [
                    "debug",
                    "Debug control",
                    "Inspect and select sessions, launch or attach, pause, continue, step, restart, and stop."
                ],
                [
                    "inspect",
                    "Breakpoints and inspection",
                    "Manage breakpoints and data breakpoints; inspect threads, stacks, variables, and raw memory while paused."
                ],
                [
                    "rtos",
                    "FreeRTOS tasks",
                    "Check RTOS awareness and read task states, priorities, and stack use while paused."
                ],
                [
                    "peripherals",
                    "Peripheral registers",
                    "Search SVD peripherals, registers, and fields, then read or write their values."
                ],
                [
                    "rtt",
                    "RTT logs",
                    "Start or stop RTT, check its connection state, read firmware output, and send commands to the firmware once you approve them."
                ],
                ["elf", "Memory usage", "Analyze ELF Flash, RAM, memory regions, sections, and largest symbols."],
                [
                    "cubemx",
                    "CubeMX generation",
                    "Inspect and check projects, prepare configuration changes, generate code, and track or cancel operations. Supports .ioc and .ioc2."
                ],
                [
                    "permission",
                    "Permissions",
                    "Inspect or clear remembered workspace permissions and pending confirmations."
                ]
            ],
            groups: [
                [
                    "setup",
                    "Connect and configure",
                    "Find probes, inspect the chip, and check memory before you begin.",
                    ["config", "target", "elf", "permission"]
                ],
                ["flash", "Flash and verify", "Program firmware, verify the result, then reset and run.", ["flash"]],
                [
                    "watch",
                    "Variables and waveforms",
                    "Read and write values, capture samples, and export the history.",
                    ["variables", "watch", "sampling"]
                ],
                [
                    "debug",
                    "Breakpoints and debugging",
                    "Control execution and inspect paused state and FreeRTOS tasks.",
                    ["debug", "inspect", "rtos"]
                ],
                [
                    "peripherals",
                    "Peripherals and logs",
                    "Read and write peripheral registers, and follow firmware RTT output.",
                    ["peripherals", "rtt"]
                ],
                [
                    "cubemx",
                    "CubeMX generation",
                    "Check projects, prepare configuration changes, and track code generation.",
                    ["cubemx"]
                ]
            ],
            toolsLabel: "MCP tools",
            detailsLabel: "Explore the tools"
        },
        tools: {
            id: "tools",
            nav: "Tools",
            title: "More tools",
            lead: "More handy tools in the sidebar.",
            items: [
                {
                    id: "peripheral",
                    title: "Peripheral registers",
                    lead: "View and change peripheral registers and bit fields from SVD, refreshed live.",
                    alt: "The TIM2 peripheral is expanded, register values keep refreshing, and CR1 is expanded to show its bit fields"
                },
                {
                    id: "rtos",
                    title: "FreeRTOS tasks",
                    lead: "See every task's state, priority, and stack use at a glance.",
                    alt: "The task table is refreshed during a debug pause, and ControlTask is expanded to show details"
                },
                {
                    id: "memory",
                    title: "Memory usage",
                    lead: "How much FLASH, RAM, and each memory region is used, at a glance.",
                    alt: "Memory usage is refreshed, showing FLASH, RAM, and CCMRAM"
                },
                {
                    id: "chip",
                    title: "Chip information",
                    lead: "Core, device ID, Flash size, and unique ID in one click.",
                    alt: "Chip information is read, and the details show device ID, unique ID, and the debug connection"
                },
                {
                    id: "rtt",
                    title: "RTT logs",
                    lead: "Firmware logs stream live into a VS Code panel. Send commands back, or save the log to a file in one click.",
                    alt: "RTT is started from the sidebar and the RTT terminal in the bottom panel streams the firmware log; log saving is turned on, then a status command is sent from the input box and the firmware answers"
                }
            ]
        },
        source: "Source",
        releases: "Releases",
        issues: "Issues",
        license: "MIT License",
        demoTitle: "EmberProbe guided tour",
        simulation: "Simulation only. No hardware connection.",
        back: "Back to website",
        reset: "Start over",
        tourTitle: "Guided tour",
        tourExit: "Exit tour",
        tourResume: "Resume tour",
        tourPreparing: "Preparing the simulation",
        tourSkip: "Skip this step",
        tourNext: "Next",
        tourNextChapter: "Next chapter",
        tourChapterDone: "Chapter complete.",
        tourAllDone: "All chapters are complete. Exit the tour to keep using the editor.",
        mobileHint: "The guided tour needs a window at least 900 pixels wide.",
        mobileLink: "See the recordings on the home page",
        noScript: "Enable JavaScript to use the guided tour."
    }
};

module.exports = { content, links, extensionId, chipVendors, agentClients, mcpTools };
