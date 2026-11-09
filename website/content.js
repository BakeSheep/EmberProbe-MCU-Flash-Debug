"use strict";

const repository = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug";

const links = {
    github: repository,
    install: "https://marketplace.visualstudio.com/items?itemName=BakeSheep.emberprobe",
    docs: `${repository}/blob/master/docs/guide/getting-started.md`,
    docsEn: `${repository}/blob/master/README_EN.md`
};

// Copy says what the visitor gets, not how to operate it or how it works; facts still follow docs/guide/.
// `chapters` runs in the order of use. A chapter's id is also its recording in website/capture/scenes.js.
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
        eyebrow: "VS Code 扩展",
        subtitle: "Agent 友好的现代化 STM32 调试插件",
        install: "安装到 VS Code",
        tour: "打开引导教程",
        notice: "画面为真实产品界面，数据为模拟数据。",
        heroAlt: "EmberProbe 界面：侧栏写入 g_target_rpm，波形图中 g_motor_rpm 随之上升",
        player: { pause: "暂停", play: "播放", enlarge: "放大", exit: "退出放大" },
        chapters: [
            {
                id: "config",
                nav: "配置",
                title: "一键启动，何须 launch.json",
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
                    chips: {
                        label: "芯片",
                        items: [
                            "STM32F0/F1/F2/F3",
                            "STM32F4/F7",
                            "STM32G0/G4",
                            "STM32H7",
                            "STM32L0/L1/L4/L5",
                            "STM32U0/U5",
                            "STM32C0/C5",
                            "STM32WB/WL",
                            "GD32",
                            "APM32",
                            "RP2040/RP2350"
                        ]
                    },
                    note: "以及 OpenOCD 支持的其他调试器和芯片"
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
                id: "variables",
                nav: "变量",
                title: "非侵入实时变量读写",
                lead: "零代码，非侵入，自动解析地址实现变量读写。",
                alt: "搜索 g_target_rpm 并加入查看和写入列表，开始采样后写入 2400，转速随之上升",
                points: [
                    ["自动解析", "从固件中读出全部变量与结构体成员，按名称搜索即可添加。"],
                    ["非侵入实时刷新", "目标运行时持续刷新数值，不打断程序。"],
                    ["随时写入", "输入新值立即写入，写完自动回读确认。"]
                ]
            },
            {
                id: "waveform",
                nav: "波形",
                wide: true,
                title: "波形与历史",
                lead: "把变量画成实时曲线，整段采样完整保留，随时回看、随时导出。",
                alt: "把采样率调到不限速，冻结图表，拖动历史时间轴，再选择曲线和范围导出 CSV",
                points: [
                    ["高速采样", "最高可达 2000+ Hz，快速变化也能看清。"],
                    ["健全的图表操作", "冻结、缩放、归一化、拖动时间轴，整段会话随时回看。"],
                    ["自由导出 CSV", "任选变量和时间段，导出原始数据继续分析。"]
                ]
            },
            {
                id: "sampling",
                nav: "采样",
                wide: true,
                title: "全场景采样",
                lead: "同一份变量列表，不调试、调试运行和断点暂停时都能用，看懂各种数据类型。",
                alt: "独立采样时开始调试，目标继续运行后曲线恢复，暂停和单步时每次读取一份当前值",
                points: [
                    ["独立运行", "不开调试也能持续观测，速度最快。"],
                    ["调试运行中", "边调试边看曲线，程序跑起来曲线就接上。"],
                    ["断点暂停时", "每次停下都刷新当前值，配合单步观察变化。"],
                    ["全类型解析", "变量、结构体、数组、C++ 类成员与智能指针、指针展开、枚举名称，开箱即读。"]
                ]
            },
            {
                id: "agent",
                nav: "Agent",
                title: "赋予 Agent 强大能力",
                lead: "内置 MCP 服务器，Agent 可以帮你烧录、读写变量、调试、查看外设和生成 CubeMX 代码。",
                alt: "在侧栏为 Gemini CLI 安装 MCP 服务器，升级 Codex 配置，再查看完全允许 Agent 操作开关",
                points: [
                    ["MCP 一键接入", "在侧栏为常用 Agent 客户端一键安装，所有工程共用。"],
                    ["敏感操作请求", "烧录、写入等操作先给出计划，你在对话中确认后才执行。"],
                    ["Skills 兼容", "附带现成的工作流 Skills，Agent 按成熟流程操作硬件。"]
                ]
            }
        ],
        agent: {
            sample: "示意",
            caption: "烧录并写入变量的过程。对话内容为示意，不代表任何客户端的界面。",
            roles: { user: "用户", agent: "Agent", tool: "工具调用", plan: "等待确认" },
            talk: [
                { role: "user", text: "烧录当前固件，把 g_target_rpm 改为 2400，然后确认转速。" },
                { role: "tool", name: "config_get, chip_read", text: "读取配置和目标芯片，不需要确认。" },
                {
                    role: "plan",
                    name: "flash_program",
                    rows: [
                        ["固件", "EmberProbeDemo.elf · sha256 3fa1…c07e"],
                        ["目标", "stm32f4x.cfg · J-Link 801012345"],
                        ["操作", "擦除、写入、校验、复位运行"]
                    ]
                },
                { role: "user", text: "确认。" },
                { role: "tool", name: "flash_program", text: "校验通过，目标已复位运行。" },
                {
                    role: "plan",
                    name: "variables_write",
                    rows: [
                        ["变量", "g_target_rpm"],
                        ["新值", "1500 → 2400"]
                    ]
                },
                { role: "user", text: "确认。" },
                { role: "tool", name: "variables_write", text: "已写入，回读值为 2400。" },
                { role: "tool", name: "variables_sample", text: "g_motor_rpm 正在上升，当前 2388。" },
                { role: "agent", text: "烧录完成。g_target_rpm 已改为 2400，g_motor_rpm 已升至 2388。" }
            ],
            facts: [
                [
                    "支持的客户端",
                    "Claude Code、Codex、Gemini CLI、OpenCode、Antigravity、DeepSeek Harness 一键安装，GitHub Copilot 和 Cursor 自动识别，其他支持 MCP 的客户端复制配置即可。"
                ],
                ["CubeMX 代码生成", "让 Agent 修改 CubeMX 配置并重新生成代码，写回前先比对并备份。"],
                ["完全允许 Agent 操作", "默认关闭，只能由你在侧栏开启。开启后免去逐次确认，安全检查依然保留。"]
            ]
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
                }
            ]
        },
        requirements: {
            id: "requirements",
            nav: "环境",
            title: "环境要求",
            rows: [
                ["编辑器", "VS Code 1.85 或更高版本"],
                ["OpenOCD", "Windows 和 Linux 已内置，其他平台使用本机 OpenOCD"],
                ["调试器", "J-Link、ST-Link、CMSIS-DAP 等主流调试器"],
                ["断点调试", "ARM GDB 工具链，装过 STM32CubeIDE 或 CubeCLT 即可"],
                ["Agent", "支持 MCP 的 Agent 客户端"],
                ["CubeMX 生成", "本机安装的 STM32CubeMX"]
            ],
            startTitle: "开始使用",
            start: [
                ["安装扩展", "在 VS Code 扩展市场搜索 EmberProbe。"],
                ["打开工程", "插上 Link，一键完成配置。"],
                ["烧录调试", "一键烧录，然后调试或观测变量。"]
            ],
            guide: "阅读使用指南"
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
        eyebrow: "VS Code extension",
        subtitle: "The modern, Agent-friendly STM32 debugging extension",
        install: "Install in VS Code",
        tour: "Open the guided tour",
        notice: "Product UI with simulated data.",
        heroAlt: "EmberProbe: g_target_rpm is written in the sidebar and g_motor_rpm rises in the waveform view",
        player: { pause: "Pause", play: "Play", enlarge: "Enlarge", exit: "Exit enlarged view" },
        chapters: [
            {
                id: "config",
                nav: "Setup",
                title: "One click to start. No launch.json.",
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
                    chips: {
                        label: "Chips",
                        items: [
                            "STM32F0/F1/F2/F3",
                            "STM32F4/F7",
                            "STM32G0/G4",
                            "STM32H7",
                            "STM32L0/L1/L4/L5",
                            "STM32U0/U5",
                            "STM32C0/C5",
                            "STM32WB/WL",
                            "GD32",
                            "APM32",
                            "RP2040/RP2350"
                        ]
                    },
                    note: "plus the other probes and chips OpenOCD supports"
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
                id: "variables",
                nav: "Variables",
                title: "Non-intrusive live variables",
                lead: "No code changes, no intrusion. Read and write variables with automatically resolved addresses.",
                alt: "g_target_rpm is found and added to the watch and write lists, sampling starts, 2400 is written, and the speed rises",
                points: [
                    [
                        "Parsed for you",
                        "Every variable and struct member comes from the firmware. Search by name to add one."
                    ],
                    [
                        "Live, without interruption",
                        "Values keep refreshing while the target runs, without stopping the program."
                    ],
                    ["Write any time", "Type a new value to write it. Each write is read back to confirm."]
                ]
            },
            {
                id: "waveform",
                nav: "Waveform",
                wide: true,
                title: "Waveforms and history",
                lead: "Plot variables as live curves and keep the whole session, ready to review or export at any time.",
                alt: "The sample rate is set to unlimited, the chart is frozen, the history timeline is dragged, and curves and a range are chosen for CSV export",
                points: [
                    ["Fast sampling", "Up to 2000+ Hz, so fast changes stay visible."],
                    [
                        "Complete chart controls",
                        "Freeze, zoom, normalize, and drag the timeline to review the whole session."
                    ],
                    ["Export CSV freely", "Pick any variables and time range and export the raw data for analysis."]
                ]
            },
            {
                id: "sampling",
                nav: "Sampling",
                wide: true,
                title: "Sampling in every scenario",
                lead: "One variable list that works standalone, while debugging, and at a breakpoint, and understands your data types.",
                alt: "Debugging starts during standalone sampling, the curves resume when the target runs, and each pause or step reads one set of current values",
                points: [
                    ["Standalone", "Watch continuously without a debug session, at the highest speed."],
                    ["While debugging", "Watch curves as you debug. They pick up again as soon as the program runs."],
                    [
                        "At a breakpoint",
                        "Every stop refreshes the current values, so you can follow changes step by step."
                    ],
                    [
                        "Every data type",
                        "Variables, structs, arrays, C++ class members and smart pointers, followed pointers, and enum names, readable out of the box."
                    ]
                ]
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
                        "Install for popular Agent clients from the sidebar, shared by all your projects."
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
            sample: "Illustration",
            caption:
                "Flashing and writing a variable. The conversation is an illustration and does not represent any client's interface.",
            roles: { user: "User", agent: "Agent", tool: "Tool call", plan: "Awaiting confirmation" },
            talk: [
                { role: "user", text: "Flash the current firmware, set g_target_rpm to 2400, then check the speed." },
                {
                    role: "tool",
                    name: "config_get, chip_read",
                    text: "Reads the configuration and target chip. No confirmation needed."
                },
                {
                    role: "plan",
                    name: "flash_program",
                    rows: [
                        ["Firmware", "EmberProbeDemo.elf · sha256 3fa1…c07e"],
                        ["Target", "stm32f4x.cfg · J-Link 801012345"],
                        ["Operation", "Erase, write, verify, reset and run"]
                    ]
                },
                { role: "user", text: "Confirm." },
                { role: "tool", name: "flash_program", text: "Verified. The target has been reset and is running." },
                {
                    role: "plan",
                    name: "variables_write",
                    rows: [
                        ["Variable", "g_target_rpm"],
                        ["New value", "1500 → 2400"]
                    ]
                },
                { role: "user", text: "Confirm." },
                { role: "tool", name: "variables_write", text: "Written. Read-back value is 2400." },
                { role: "tool", name: "variables_sample", text: "g_motor_rpm is rising, currently 2388." },
                {
                    role: "agent",
                    text: "Flashing is complete. g_target_rpm is now 2400, and g_motor_rpm has reached 2388."
                }
            ],
            facts: [
                [
                    "Supported clients",
                    "One-click install for Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, and DeepSeek Harness. GitHub Copilot and Cursor are detected automatically, and any other MCP client can copy the configuration."
                ],
                [
                    "CubeMX code generation",
                    "Let the Agent change the CubeMX configuration and regenerate code. Results are compared and backed up before they are written."
                ],
                [
                    "Allow all Agent operations",
                    "Off by default, and only you can turn it on in the sidebar. It skips per-operation confirmation while the safety checks stay in place."
                ]
            ]
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
                }
            ]
        },
        requirements: {
            id: "requirements",
            nav: "Requirements",
            title: "Requirements",
            rows: [
                ["Editor", "VS Code 1.85 or later"],
                ["OpenOCD", "Built in on Windows and Linux. Other platforms use a local OpenOCD."],
                ["Debug probes", "J-Link, ST-Link, CMSIS-DAP, and other popular probes"],
                ["Breakpoint debugging", "An ARM GDB toolchain. STM32CubeIDE or CubeCLT is enough."],
                ["Agents", "An Agent client that supports MCP"],
                ["CubeMX generation", "A local STM32CubeMX installation"]
            ],
            startTitle: "Get started",
            start: [
                ["Install the extension", "Search for EmberProbe in the VS Code Marketplace."],
                ["Open your project", "Plug in your probe and set everything up in one click."],
                ["Flash and debug", "Flash in one click, then debug or watch variables."]
            ],
            guide: "Read the guide"
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

module.exports = { content, links };
