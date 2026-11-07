"use strict";

const repository = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug";

const links = {
    github: repository,
    install: "https://marketplace.visualstudio.com/items?itemName=BakeSheep.emberprobe",
    docs: `${repository}/blob/master/docs/guide/getting-started.md`,
    docsEn: `${repository}/blob/master/README_EN.md`
};

// `chapters` runs in the order of use. A chapter's id is also its recording in website/capture/scenes.js, and its
// steps match that scene's `steps` one to one.
const content = {
    zh: {
        htmlLang: "zh-CN",
        title: "EmberProbe：Cortex-M 烧录、调试与实时观测",
        description:
            "基于 OpenOCD 的 VS Code 扩展，提供固件烧录、断点调试、运行时变量采样与写入，并通过 MCP 服务器向 Agent 开放这些能力。",
        skip: "跳到正文",
        language: "English",
        navLabel: "主导航",
        projectLabel: "项目链接",
        headline: "Cortex-M 烧录、调试与实时观测",
        intro: "基于 OpenOCD 的 VS Code 扩展，提供固件烧录、断点调试、运行时变量采样与写入，并通过 MCP 服务器向 Agent 开放这些能力。",
        install: "安装到 VS Code",
        tour: "打开引导教程",
        notice: "画面为真实产品界面，数据为模拟数据，等待时间已缩短。",
        heroAlt: "EmberProbe 侧栏写入 g_target_rpm 后，波形图中的 g_motor_rpm 随之上升",
        player: { pause: "暂停", play: "播放", enlarge: "放大", exit: "退出放大" },
        chapters: [
            {
                id: "config",
                nav: "配置",
                title: "配置连接",
                lead: "扫描工作区并填入 ELF、调试器脚本和 MCU 目标。已连接的探针列在侧栏，按工作区保存选择。",
                alt: "点击自动检测配置后填入固件和脚本，刷新探针列表显示内核型号，再选择探针并切换 J-Link 驱动",
                steps: [
                    ["自动检测配置", "扫描工作区，填入 ELF、调试器脚本和 MCU 目标。也可以逐项手动选择。"],
                    [
                        "选择探针",
                        "刷新时读取每台探针所连芯片的内核型号，不暂停、不复位、不写入目标。点击探针后按工作区保存。"
                    ],
                    [
                        "切换 J-Link 驱动",
                        "Windows 上的 J-Link 需要 WinUSB 驱动。在列表中切换，需要管理员授权，原驱动会备份，可切回 SEGGER。"
                    ]
                ],
                limit: "切换到 WinUSB 后，Ozone 等 SEGGER 工具可能无法使用该探针。只连一台探针时不需要选择。"
            },
            {
                id: "flash",
                nav: "烧录",
                title: "烧录",
                lead: "擦除、写入、校验并复位运行。烧录时自动提高 SWD 时钟，失败后恢复原时钟重试一次。",
                alt: "点击烧录后，侧栏显示当前阶段，终端输出 OpenOCD 日志和烧录摘要",
                steps: [
                    ["点击“烧录”", "使用 MCU 配置中的 ELF、探针和目标。也可以在资源管理器中右键 ELF。"],
                    ["连接目标", "OpenOCD 启动后，终端输出目标电压、适配器时钟、器件 ID 和 Flash 容量。"],
                    ["写入并校验", "侧栏显示当前阶段，终端输出写入和校验的字节数、耗时与速度。"],
                    ["复位运行", "校验通过后复位目标，终端输出本次烧录摘要。"]
                ],
                limit: "每次都完整擦除和写入，固件与目标 Flash 相同时也不跳过。自动提速只用于 Cortex-M 的 SWD 连接。"
            },
            {
                id: "debug",
                nav: "调试",
                title: "断点调试",
                lead: "内置调试器支持断点、单步、调用栈、变量与寄存器查看。可以下载固件后调试，也可以附加到运行中的目标。",
                alt: "设置断点后复位调试，停在 main，继续运行命中断点并单步，停止后用不复位调试附加到目标",
                steps: [
                    ["设置断点", "在编辑器行号左侧点击。"],
                    ["复位调试", "下载固件，然后停在入口 main。"],
                    ["继续与单步", "调试工具栏提供继续、单步、重启和停止。调试控制台接受 GDB 命令。"],
                    ["不复位调试", "附加到运行中的目标，不写入 Flash。"]
                ],
                limit: "需要 ARM GDB、objdump 和 nm，自动在 PATH、ST bundles、CubeCLT 和 CubeIDE 中查找。多核调试和外部 GDB 服务器为实验功能。"
            },
            {
                id: "variables",
                nav: "变量",
                title: "变量读写",
                lead: "从 ELF 解析变量和结构体成员，在目标运行时读取和写入 RAM。",
                alt: "搜索 g_target_rpm 并加入查看和写入列表，开始采样后写入 2400，转速随之上升",
                steps: [
                    ["搜索变量", "在 ELF 全部变量中按名称筛选。"],
                    ["加入列表", "分别加入查看列表和写入列表。"],
                    ["开始采样", "侧栏以固定 20 Hz 刷新数值，不保留历史。"],
                    ["写入并回读", "输入新值后按 Enter，写入后自动回读校验。"]
                ],
                limit: "只有对齐的 32 位变量写入时不暂停目标。其他变量写入时短暂暂停 CPU，列表中显示风险提示，调试会话运行中不能写入。"
            },
            {
                id: "waveform",
                nav: "波形",
                wide: true,
                title: "波形与历史",
                lead: "绘制变量曲线并记录整段采样过程。可以冻结图表回看历史，再把原始采样点导出为 CSV。",
                alt: "把采样率调到不限速，冻结图表，拖动历史时间轴，再选择曲线和范围导出 CSV",
                steps: [
                    ["设置采样率", "范围 0.1 到 200 Hz，默认 30 Hz，滑到最右为不限速。"],
                    ["冻结图表", "图表固定，后台继续采样并更新当前值。"],
                    ["回看历史", "时间轴覆盖整段会话，较早的数据从磁盘归档读取。"],
                    ["导出 CSV", "选择变量和时间范围，导出原始采样点，包括已移出内存的历史。"]
                ],
                limit: "实际频率取决于探针吞吐、变量数量和地址分布。不限速只在独立采样时生效，Agent 无法开启。"
            },
            {
                id: "sampling",
                nav: "采样",
                wide: true,
                title: "三种采样场景",
                lead: "同一套变量列表在独立运行、调试运行和调试暂停时都可用，采样方式随目标状态切换。",
                alt: "独立采样时开始调试，目标继续运行后曲线恢复，暂停和单步时每次读取一份当前值",
                steps: [
                    ["独立采样", "不启动调试，持续读取目标 RAM。可以使用不限速。"],
                    ["调试运行时", "启动调试时采样暂停，目标运行后按设定频率恢复。"],
                    ["调试暂停时", "不连续采样，每次停下读取一份当前值。"]
                ],
                limit: "调试时不限速不生效，按最近一次设置的有限频率采样。多核调试组不支持运行时采样。"
            },
            {
                id: "agent",
                nav: "Agent",
                title: "Agent 与 MCP",
                lead: "随扩展提供 MCP 服务器，Agent 可以调用烧录、变量、调试、外设和 CubeMX 工具。",
                alt: "在侧栏为 Gemini CLI 安装 MCP 服务器，升级 Codex 配置，再查看完全允许 Agent 操作开关",
                steps: [
                    ["安装 MCP 服务器", "在侧栏逐个客户端安装。只写用户级配置，所有工程共用一份。"],
                    ["升级配置", "启动路径或超时过期时显示“可升级”。"],
                    ["管理权限", "Agent Skills 和“完全允许 Agent 操作”也在这张卡片中。"]
                ],
                limit: "读取芯片信息、变量和外设不需要逐次确认。烧录、Flash 校验、写入和 CubeMX 生成默认在 Agent 对话中确认。"
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
                    "Claude Code、Codex、Gemini CLI、OpenCode、Antigravity、DeepSeek Harness 在侧栏安装。VS Code 中的 GitHub Copilot 和 Cursor 自动注册。其他客户端复制配置。"
                ],
                ["连接条件", "保持 EmberProbe 窗口运行，并为工作区开启 Agent 访问。MCP 只支持 stdio 传输。"],
                [
                    "Agent Skills",
                    "安装到工作区后，Agent 可按 skills 中的流程操作硬件。已安装的 skills 被改动后需要重新批准。"
                ],
                [
                    "CubeMX 代码生成",
                    "修改先在临时副本上进行。确认后重新生成当前配置和新配置两份结果，比较后写回，写回前备份被修改的文件。"
                ],
                [
                    "完全允许 Agent 操作",
                    "默认关闭，只能在侧栏开启，Agent 不能自己打开。开启后免去操作确认，探针独占、身份校验和写入回读仍然保留。"
                ]
            ]
        },
        tools: {
            id: "tools",
            nav: "工具",
            title: "更多工具",
            lead: "侧栏中的其他功能。",
            items: [
                {
                    id: "peripheral",
                    title: "外设寄存器",
                    lead: "按 SVD 查看和写入外设、寄存器与位域，不需要 ELF。",
                    alt: "展开 TIM2 外设，寄存器值持续刷新，再展开 CR1 查看位域",
                    limit: "独立使用时需要采样连接，已展开的寄存器最高 20 Hz 刷新。单核调试运行和暂停时都可用，多核和外部 GDB 只在暂停时可用。"
                },
                {
                    id: "rtos",
                    title: "FreeRTOS 任务",
                    lead: "目标暂停时列出任务状态、优先级和栈使用，可筛选和排序。",
                    alt: "调试暂停时刷新任务表，再展开 ControlTask 查看详情",
                    limit: "支持小端单核 ARM32，不支持 SMP。栈使用率是根据填充值得到的估算值。"
                },
                {
                    id: "memory",
                    title: "内存占用",
                    lead: "从 map 文件统计 FLASH、RAM 和各内存区域的占用。",
                    alt: "刷新内存占用，显示 FLASH、RAM 和 CCMRAM 的用量",
                    limit: "FLASH 和 RAM 汇总是段字节数，不是运行时栈峰值。区域占用包含间隙和保留空间。"
                },
                {
                    id: "chip",
                    title: "芯片信息",
                    lead: "读取内核、器件 ID、Flash 容量、唯一 ID 和调试连接信息。",
                    alt: "读取芯片信息，展开详情查看器件 ID、唯一 ID 和调试连接",
                    limit: "采样、调试或烧录进行时不能读取。"
                }
            ]
        },
        requirements: {
            id: "requirements",
            nav: "环境",
            title: "环境要求",
            rows: [
                ["编辑器", "VS Code 1.85 或更高版本"],
                ["OpenOCD", "Windows x64 和 Linux x64 使用默认路径时自动准备内置版本。其他平台指定已安装的 OpenOCD。"],
                [
                    "探针",
                    "J-Link、CMSIS-DAP、ST-Link、XDS110、Nu-Link、TI-ICDI、FTDI、FT232R、VSLLINK、KitProg，以及其他 OpenOCD 适配器"
                ],
                [
                    "断点调试",
                    "ARM GDB、objdump 和 nm。已安装 STM32CubeCLT、STM32CubeIDE 或 ST bundles 时通常无需配置。"
                ],
                ["Agent", "支持 MCP stdio 的客户端，或使用工作区 Agent Skills"],
                ["CubeMX 生成", "本机安装的 STM32CubeMX 或 STM32CubeMX2"]
            ],
            startTitle: "开始使用",
            start: [
                ["安装扩展", "在 VS Code 扩展市场安装 EmberProbe。"],
                ["配置工程", "打开工程，连接探针，点击“自动检测配置”。"],
                ["烧录", "点击“烧录”，之后可以开始调试或采样。"]
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
        title: "EmberProbe: Flash, debug, and observe Cortex-M firmware",
        description:
            "A VS Code extension built on OpenOCD for firmware flashing, breakpoint debugging, and runtime variable sampling and writes, with the same operations available to Agents through an MCP server.",
        skip: "Skip to content",
        language: "中文",
        navLabel: "Main navigation",
        projectLabel: "Project links",
        headline: "Flash, debug, and observe Cortex-M firmware",
        intro: "A VS Code extension built on OpenOCD for firmware flashing, breakpoint debugging, and runtime variable sampling and writes, with the same operations available to Agents through an MCP server.",
        install: "Install in VS Code",
        tour: "Open the guided tour",
        notice: "Product UI with simulated data. Waiting time is shortened.",
        heroAlt: "After g_target_rpm is written in the EmberProbe sidebar, g_motor_rpm rises in the waveform view",
        player: { pause: "Pause", play: "Play", enlarge: "Enlarge", exit: "Exit enlarged view" },
        chapters: [
            {
                id: "config",
                nav: "Setup",
                title: "Setup",
                lead: "Scans the workspace and fills in the ELF, debugger script, and MCU target. Connected probes are listed in the sidebar, and the selection is saved per workspace.",
                alt: "Auto-detect fills in the firmware and scripts, a refresh shows each probe's core, then a probe is selected and its J-Link driver is switched",
                steps: [
                    [
                        "Auto-detect the configuration",
                        "Scans the workspace and fills in the ELF, debugger script, and MCU target. Each one can also be selected by hand."
                    ],
                    [
                        "Select a probe",
                        "A refresh reads the core of the chip on each probe without halting, resetting, or writing to the target. Clicking a probe saves it for the workspace."
                    ],
                    [
                        "Switch the J-Link driver",
                        "J-Link on Windows needs the WinUSB driver. Switch it in the list with administrator approval. The original driver is backed up, so you can switch back to SEGGER."
                    ]
                ],
                limit: "After switching to WinUSB, Ozone and other SEGGER tools may not work with that probe. With a single probe connected, no selection is needed."
            },
            {
                id: "flash",
                nav: "Flash",
                title: "Flash",
                lead: "Erases, writes, verifies, then resets and runs. Flashing raises the SWD clock automatically and retries once at the original clock on failure.",
                alt: "After Flash is clicked, the sidebar shows the current stage and the terminal shows the OpenOCD log and a summary",
                steps: [
                    [
                        "Click Flash",
                        "Uses the ELF, probe, and target from MCU Configuration. You can also right-click an ELF in the Explorer."
                    ],
                    [
                        "Connect to the target",
                        "After OpenOCD starts, the terminal shows target voltage, adapter clock, device ID, and Flash size."
                    ],
                    [
                        "Write and verify",
                        "The sidebar shows the current stage. The terminal shows bytes, time, and speed for the write and the verify."
                    ],
                    ["Reset and run", "After verification passes, the target resets and the terminal shows a summary."]
                ],
                limit: "Every run erases and writes in full, even when the firmware matches the target Flash. The automatic clock increase applies only to Cortex-M SWD connections."
            },
            {
                id: "debug",
                nav: "Debug",
                title: "Breakpoint debugging",
                lead: "The built-in debugger provides breakpoints, stepping, and call stack, variable, and register views. Start by downloading the firmware, or attach to a running target.",
                alt: "A breakpoint is set, reset debugging stops at main, Continue reaches the breakpoint, then stepping, stopping, and attaching without a reset",
                steps: [
                    ["Set a breakpoint", "Click left of the line number in the editor."],
                    ["Debug with reset", "Downloads the firmware, then stops at the entry point, main."],
                    [
                        "Continue and step",
                        "The debug toolbar provides Continue, Step, Restart, and Stop. The debug console accepts GDB commands."
                    ],
                    ["Debug without reset", "Attaches to the running target and does not write Flash."]
                ],
                limit: "Requires ARM GDB, objdump, and nm, found automatically in PATH, ST bundles, CubeCLT, and CubeIDE. Multicore debugging and external GDB servers are experimental."
            },
            {
                id: "variables",
                nav: "Variables",
                title: "Variable reads and writes",
                lead: "Parses variables and struct members from the ELF, then reads and writes RAM while the target runs.",
                alt: "g_target_rpm is found and added to the watch and write lists, sampling starts, 2400 is written, and the speed rises",
                steps: [
                    ["Search for a variable", "Filter all ELF variables by name."],
                    ["Add it to the lists", "Add it to the watch list and to the write list."],
                    ["Start sampling", "The sidebar refreshes values at a fixed 20 Hz and keeps no history."],
                    [
                        "Write and read back",
                        "Enter the new value and press Enter. Each write is verified by reading it back."
                    ]
                ],
                limit: "Only aligned 32-bit variables are written without halting the target. Other variables briefly halt the CPU, show a risk hint in the list, and cannot be written while a debug session is running."
            },
            {
                id: "waveform",
                nav: "Waveform",
                wide: true,
                title: "Waveforms and history",
                lead: "Plots variable curves and records the whole sampling session. Freeze the chart to review history, then export the raw samples as CSV.",
                alt: "The sample rate is set to unlimited, the chart is frozen, the history timeline is dragged, and curves and a range are chosen for CSV export",
                steps: [
                    [
                        "Set the sample rate",
                        "0.1 to 200 Hz, 30 Hz by default. The far right of the slider is Unlimited."
                    ],
                    [
                        "Freeze the chart",
                        "The chart holds still while sampling and current values continue in the background."
                    ],
                    [
                        "Review history",
                        "The timeline covers the whole session. Older data is read from the disk archive."
                    ],
                    [
                        "Export CSV",
                        "Choose variables and a time range. Raw samples are exported, including history no longer in memory."
                    ]
                ],
                limit: "Actual rate depends on probe throughput, variable count, and address spread. Unlimited applies only to standalone sampling, and Agents cannot enable it."
            },
            {
                id: "sampling",
                nav: "Sampling",
                wide: true,
                title: "Three sampling modes",
                lead: "The same variable list works while running standalone, while debugging, and while paused. The sampling method follows the target state.",
                alt: "Debugging starts during standalone sampling, the curves resume when the target runs, and each pause or step reads one set of current values",
                steps: [
                    ["Standalone", "Reads target RAM continuously with no debug session. Unlimited is available."],
                    [
                        "Debug session, running",
                        "Sampling pauses when debugging starts and resumes at the set rate once the target runs."
                    ],
                    ["Debug session, paused", "Sampling is not continuous. Each stop reads one set of current values."]
                ],
                limit: "Unlimited has no effect while debugging. Sampling uses the last finite rate instead. Multicore debug groups do not support runtime sampling."
            },
            {
                id: "agent",
                nav: "Agent",
                title: "Agents and MCP",
                lead: "The extension ships an MCP server, so Agents can call its flash, variable, debug, peripheral, and CubeMX tools.",
                alt: "The MCP server is installed for Gemini CLI in the sidebar, the Codex configuration is upgraded, and the Allow all Agent operations switch is shown",
                steps: [
                    [
                        "Install the MCP server",
                        "Install per client in the sidebar. Only user-level configuration is written, and all projects share it."
                    ],
                    ["Upgrade the configuration", "Shows Outdated when the launch path or timeout has changed."],
                    ["Manage access", "Agent Skills and Allow all Agent operations are on the same card."]
                ],
                limit: "Reading chip information, variables, and peripherals needs no per-operation confirmation. Flashing, Flash verification, writes, and CubeMX generation are confirmed in the Agent conversation by default."
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
                    "Install for Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, and DeepSeek Harness in the sidebar. GitHub Copilot in VS Code and Cursor register automatically. Other clients copy the configuration."
                ],
                [
                    "Connection",
                    "Keep the EmberProbe window running and enable Agent access for the workspace. MCP supports stdio transport only."
                ],
                [
                    "Agent Skills",
                    "Once installed in the workspace, Agents can operate hardware through the procedures in the skills. Modified skills need approval again."
                ],
                [
                    "CubeMX generation",
                    "Changes start on a temporary copy. After confirmation, both the current and new configurations are regenerated and compared before writing back. Modified files are backed up first."
                ],
                [
                    "Allow all Agent operations",
                    "Off by default and available only in the sidebar. Agents cannot turn it on. It removes operation confirmations, while probe ownership, identity checks, and write read-back remain."
                ]
            ]
        },
        tools: {
            id: "tools",
            nav: "Tools",
            title: "More tools",
            lead: "Other features in the sidebar.",
            items: [
                {
                    id: "peripheral",
                    title: "Peripheral registers",
                    lead: "View and write peripherals, registers, and bit fields from SVD. No ELF needed.",
                    alt: "The TIM2 peripheral is expanded, register values keep refreshing, and CR1 is expanded to show its bit fields",
                    limit: "Standalone use needs a sampling connection, and expanded registers refresh at up to 20 Hz. Available while running or paused in single-core debugging, and only while paused with multicore or external GDB."
                },
                {
                    id: "rtos",
                    title: "FreeRTOS tasks",
                    lead: "Lists task state, priority, and stack use while the target is paused, with filtering and sorting.",
                    alt: "The task table is refreshed during a debug pause, and ControlTask is expanded to show details",
                    limit: "Supports little-endian single-core ARM32, not SMP. Stack use is an estimate from the fill pattern."
                },
                {
                    id: "memory",
                    title: "Memory usage",
                    lead: "Reports FLASH, RAM, and memory region usage from the map file.",
                    alt: "Memory usage is refreshed, showing FLASH, RAM, and CCMRAM",
                    limit: "The FLASH and RAM totals are section bytes, not a runtime stack peak. Region usage includes gaps and reserved space."
                },
                {
                    id: "chip",
                    title: "Chip information",
                    lead: "Reads the core, device ID, Flash size, unique ID, and debug connection details.",
                    alt: "Chip information is read, and the details show device ID, unique ID, and the debug connection",
                    limit: "Not available while sampling, debugging, or flashing."
                }
            ]
        },
        requirements: {
            id: "requirements",
            nav: "Requirements",
            title: "Requirements",
            rows: [
                ["Editor", "VS Code 1.85 or later"],
                [
                    "OpenOCD",
                    "On Windows x64 and Linux x64, the bundled version is prepared automatically with the default path. On other platforms, point to an installed OpenOCD."
                ],
                [
                    "Probes",
                    "J-Link, CMSIS-DAP, ST-Link, XDS110, Nu-Link, TI-ICDI, FTDI, FT232R, VSLLINK, KitProg, and other OpenOCD adapters"
                ],
                [
                    "Breakpoint debugging",
                    "ARM GDB, objdump, and nm. Usually no setup is needed if STM32CubeCLT, STM32CubeIDE, or ST bundles are installed."
                ],
                ["Agents", "A client that supports MCP over stdio, or workspace Agent Skills"],
                ["CubeMX generation", "A local STM32CubeMX or STM32CubeMX2 installation"]
            ],
            startTitle: "Get started",
            start: [
                ["Install the extension", "Install EmberProbe from the VS Code Marketplace."],
                ["Configure the project", "Open the project, connect a probe, and click Auto-detect Configuration."],
                ["Flash", "Click Flash, then start debugging or sampling."]
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
