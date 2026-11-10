"use strict";

// Guided tour chapters for the demo page. Every chapter starts in a fresh mockup, so a chapter never depends on
// what an earlier one did. `setup` runs before the first step and may only do what a user could do in the mockup.
//
// A step highlights `target` (a selector, or a function of the frame's document) inside `frame`: "sidebar" by
// default, "chart" for the waveform panel or "shell" for the editor around them. `done` says what completes it:
// "click", "input", "enter", "hover", "read" (the visitor presses Next) or a function polled with the environment
// from website/demo.js. `after` runs once the step is complete.
// Selectors match the ones in website/capture/scenes.js and website/capture/check-tour.js walks them all.
(() => {
    const command = (name) => `[data-command="mcu-vscode.${name}"]`;
    const BREAKPOINT_LINE = 103;
    const gutterLine = `#gutter .gutter-line[data-line="${BREAKPOINT_LINE}"]`;

    function openSections(env, ids) {
        for (const section of env.sidebar.querySelectorAll("details")) {
            if (section.id && !section.closest(".values")) section.open = ids.includes(section.id);
        }
    }

    function reveal(env, id) {
        env.sidebar.getElementById(id).scrollIntoView({ block: "start" });
    }

    async function showTab(env, id) {
        env.shell.querySelector(`.tab[data-tab="${id}"]`).click();
        await env.sleep(200);
    }

    // The mock opens VS Code's Run and Debug view when a debug session starts, as VS Code does.
    function showEmberProbe(env) {
        const items = [...env.shell.querySelectorAll(".activity-item[data-view]")];
        items.find((item) => /ember|mcu/i.test(item.dataset.view)).click();
    }

    const debugging = (env) => !env.shell.getElementById("debug-toolbar").classList.contains("hidden");

    function setChartWindow(env, seconds) {
        const span = env.chart.getElementById("timeWindow");
        span.value = seconds;
        span.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Variables of different ranges stay readable on one axis only when normalized.
    function normalize(env) {
        env.chart.getElementById("norm").click();
    }

    async function removeBreakpoint(env) {
        await showTab(env, "main.c");
        env.shell.querySelector(gutterLine).click();
    }

    const chapters = [
        {
            id: "config",
            title: { zh: "配置连接", en: "Configure the connection" },
            setup(env) {
                openSections(env, ["mcuConfigSection", "probeConfig"]);
            },
            steps: [
                {
                    target: command("autoDetect"),
                    done: "click",
                    zh: ["点击“自动检测配置”", "扫描工作区，填入 ELF、调试器脚本和 MCU 目标。"],
                    en: [
                        "Click Auto-detect Configuration",
                        "Scans the workspace and fills in the ELF, debugger script, and MCU target."
                    ]
                },
                {
                    target: "#connectedProbeRefresh",
                    done: "click",
                    zh: ["刷新探针列表", "读取每台探针所连芯片的内核型号，不暂停、不复位、不写入目标。"],
                    en: [
                        "Refresh the probe list",
                        "Reads the core of the chip on each probe without halting, resetting, or writing to the target."
                    ]
                },
                {
                    target: "#connectedProbeList .probe-card:nth-child(2) .probe-card-main",
                    done: "click",
                    zh: ["选择探针", "选择按工作区保存。只连一台探针时不需要选择。"],
                    en: [
                        "Select a probe",
                        "The choice is saved for the workspace. With one probe connected, no selection is needed."
                    ]
                },
                {
                    target: "#connectedProbeList .probe-card:nth-child(2) select",
                    done: "input",
                    zh: ["切换 J-Link 驱动", "Windows 上的 J-Link 需要 WinUSB 驱动。原驱动会备份，可切回 SEGGER。"],
                    en: [
                        "Change the J-Link driver",
                        "J-Link on Windows needs the WinUSB driver. The original driver is backed up and can be restored."
                    ]
                }
            ]
        },
        {
            id: "flash",
            title: { zh: "烧录", en: "Flash" },
            setup(env) {
                openSections(env, ["flashDebugSection"]);
            },
            steps: [
                {
                    target: command("download"),
                    done: "click",
                    zh: ["点击“烧录”", "使用 MCU 配置中的 ELF、探针和目标。"],
                    en: ["Click Flash", "Uses the ELF, probe, and target from the MCU configuration."]
                },
                {
                    frame: "shell",
                    target: "#terminalBody",
                    done: (env) =>
                        /(Flash 容量|Flash size) 1024 kbytes/.test(
                            env.shell.getElementById("terminalBody").textContent
                        ),
                    zh: ["查看终端输出", "终端依次输出连接信息、写入和校验结果。校验通过后复位目标。"],
                    en: [
                        "Follow the terminal",
                        "The terminal shows the connection, the write, and the verification. The target resets after verification passes."
                    ]
                }
            ]
        },
        {
            id: "debug",
            title: { zh: "断点调试", en: "Debug" },
            async setup(env) {
                openSections(env, ["flashDebugSection"]);
                await removeBreakpoint(env);
                env.shell.querySelector(gutterLine).scrollIntoView({ block: "center" });
            },
            steps: [
                {
                    frame: "shell",
                    target: gutterLine,
                    done: "click",
                    zh: ["设置断点", "在高亮的行号左侧点击。"],
                    en: ["Set a breakpoint", "Click to the left of the highlighted line number."]
                },
                {
                    target: command("debug"),
                    done: "click",
                    zh: ["点击“复位调试”", "下载固件，然后停在入口 main。"],
                    en: ["Click Debug With Reset", "Downloads the firmware, then stops at the entry point, main."]
                },
                {
                    frame: "shell",
                    target: "#dbgContinue",
                    done: "click",
                    zh: ["继续运行", "目标运行到刚才设置的断点。"],
                    en: ["Continue", "The target runs to the breakpoint."]
                },
                {
                    frame: "shell",
                    target: "#dbgStepOver",
                    done: "click",
                    zh: ["单步跳过", "执行当前行，左侧“运行和调试”视图同步更新变量和调用栈。"],
                    en: [
                        "Step over",
                        "Runs the current line. The Run and Debug view updates its variables and call stack."
                    ]
                },
                {
                    frame: "shell",
                    target: "#dbgStop",
                    done: "click",
                    after: showEmberProbe,
                    zh: ["停止调试", "结束调试会话。"],
                    en: ["Stop", "Ends the debug session."]
                },
                {
                    target: command("attachDebug"),
                    done: "click",
                    zh: ["点击“不复位调试”", "附加到运行中的目标，不写入 Flash。"],
                    en: ["Click Debug Without Reset", "Attaches to the running target and does not write Flash."]
                }
            ]
        },
        {
            id: "variables",
            title: { zh: "变量读写", en: "Read and write variables" },
            setup(env) {
                openSections(env, ["liveValuesSection", "variableBrowser"]);
                reveal(env, "liveValuesSection");
                // A short list, with the variable this chapter adds not on it yet.
                for (const selector of [
                    '.av-write[data-selection-name="g_target_rpm"]',
                    '.av-watch[data-selection-name="g_bus_voltage"]',
                    '.av-watch[data-selection-name="g_imu"]'
                ])
                    env.sidebar.querySelector(selector).click();
            },
            steps: [
                {
                    target: "#varSearch",
                    done: (env) => env.sidebar.getElementById("varSearch").value.toLowerCase().includes("target"),
                    zh: ["搜索变量", "在搜索框中输入 target。列表来自 ELF 中的全部变量。"],
                    en: [
                        "Search for a variable",
                        "Type target in the search box. The list holds every variable in the ELF."
                    ]
                },
                {
                    target: '#availableVars .av-watch[data-selection-name="g_target_rpm"]',
                    done: "click",
                    zh: ["加入查看列表", "加入后在采样时显示 g_target_rpm 的当前值。"],
                    en: ["Add to the watch list", "The current value of g_target_rpm appears while sampling."]
                },
                {
                    target: '#availableVars .av-write[data-selection-name="g_target_rpm"]',
                    done: "click",
                    zh: ["加入写入列表", "写入列表提供输入框，数值型变量还提供步进和滑块。"],
                    en: [
                        "Add to the write list",
                        "The write list provides an input, and numeric variables also get steppers and a slider."
                    ]
                },
                {
                    target: "#liveToggle",
                    done: "click",
                    zh: ["开始采样", "侧栏以固定 20 Hz 刷新数值。"],
                    en: ["Start sampling", "The sidebar refreshes values at a fixed 20 Hz."]
                },
                {
                    target: '.write-row[data-reorder-key="g_target_rpm"] .write-input',
                    done: "enter",
                    zh: ["写入新值", "输入 2400 后按 Enter，写入后自动回读校验。"],
                    en: [
                        "Write a new value",
                        "Enter 2400 and press Enter. The value is read back and verified after the write."
                    ]
                }
            ]
        },
        {
            id: "waveform",
            title: { zh: "波形与历史", en: "Waveforms and history" },
            query: "&unlimited=1",
            setup(env) {
                openSections(env, ["liveValuesSection"]);
                setChartWindow(env, "10");
                env.chart.getElementById("run").click();
                normalize(env);
            },
            steps: [
                {
                    frame: "chart",
                    target: "#frequencyToggle",
                    done: "click",
                    zh: ["打开采样率设置", "范围 0.1 到 200 Hz，默认 30 Hz。"],
                    en: ["Open the sample rate", "The range is 0.1 to 200 Hz, and the default is 30 Hz."]
                },
                {
                    frame: "chart",
                    target: "#frequencyPreset",
                    done: "input",
                    zh: ["拖动滑块", "滑到最右为不限速。实际频率取决于探针吞吐和变量数量。"],
                    en: [
                        "Drag the slider",
                        "The far right is Unlimited. Actual rate depends on probe throughput and variable count."
                    ]
                },
                {
                    frame: "chart",
                    target: "#freeze",
                    done: "click",
                    zh: ["冻结图表", "图表固定，后台继续采样并更新当前值。"],
                    en: ["Freeze the chart", "The chart holds still while sampling and current values continue."]
                },
                {
                    frame: "chart",
                    target: (doc) => doc.getElementById("chartFromRange").parentElement,
                    done: "input",
                    zh: ["回看历史", "拖动时间轴两端的手柄。时间轴覆盖整段会话。"],
                    en: [
                        "Review history",
                        "Drag a handle at either end of the timeline. The timeline covers the whole session."
                    ]
                },
                {
                    frame: "chart",
                    target: "#export",
                    done: "click",
                    zh: ["打开导出", "选择变量和时间范围。"],
                    en: ["Open the export", "Choose the variables and the time range."]
                },
                {
                    frame: "chart",
                    target: "#exportApply",
                    done: "click",
                    zh: ["导出 CSV", "下载所选范围的模拟采样点，包括已移出内存的历史。"],
                    en: [
                        "Export the CSV",
                        "Downloads the simulated samples in the range, including history no longer in memory."
                    ]
                }
            ]
        },
        {
            id: "sampling",
            title: { zh: "三种采样场景", en: "Three sampling modes" },
            async setup(env) {
                openSections(env, ["flashDebugSection", "liveValuesSection"]);
                setChartWindow(env, "10");
                normalize(env);
                // Without the default breakpoint the target keeps running after Continue.
                await removeBreakpoint(env);
                await showTab(env, "livewatch");
            },
            steps: [
                {
                    frame: "chart",
                    target: "#run",
                    done: "click",
                    zh: ["独立采样", "不启动调试，持续读取目标 RAM。"],
                    en: ["Standalone sampling", "Reads target RAM continuously without a debug session."]
                },
                {
                    target: command("attachDebug"),
                    done: "click",
                    zh: ["启动调试", "点击“不复位调试”。启动调试时采样暂停。"],
                    en: ["Start debugging", "Click Debug Without Reset. Sampling pauses while the session starts."]
                },
                {
                    frame: "shell",
                    target: "#dbgContinue",
                    done: "click",
                    after: (env) => showTab(env, "livewatch"),
                    zh: ["继续运行", "目标运行后，采样按设定频率恢复。"],
                    en: ["Continue", "Once the target runs, sampling resumes at the set rate."]
                },
                {
                    frame: "shell",
                    target: "#dbgContinue",
                    done: "click",
                    zh: ["暂停目标", "曲线恢复后，点击同一个按钮暂停。"],
                    en: ["Pause the target", "After the curves resume, click the same button to pause."]
                },
                {
                    frame: "shell",
                    target: "#dbgStepOver",
                    done: "click",
                    zh: ["单步", "暂停时不连续采样，每次停下读取一份当前值。"],
                    en: [
                        "Step",
                        "While paused there is no continuous sampling. Each stop reads one set of current values."
                    ]
                }
            ]
        },
        {
            id: "peripheral",
            title: { zh: "外设寄存器", en: "Peripheral registers" },
            async setup(env) {
                openSections(env, ["peripheralSection"]);
                env.sidebar.getElementById("liveToggle").click();
                await env.sleep(800);
                reveal(env, "peripheralSection");
            },
            steps: [
                {
                    target: (doc) =>
                        [...doc.querySelectorAll(".peripheral-name")].find((name) => name.textContent === "TIM2"),
                    done: "click",
                    zh: ["展开外设", "展开 TIM2。外设和寄存器定义来自 SVD 文件。"],
                    en: ["Expand a peripheral", "Expand TIM2. Peripherals and registers come from the SVD file."]
                },
                {
                    target: (doc) =>
                        [...doc.querySelectorAll(".peripheral-register")]
                            .find((row) => /\bCR1\b/.test(row.textContent))
                            ?.querySelector(".peripheral-disclosure"),
                    done: "click",
                    zh: ["查看位域", "展开 CR1。运行中已展开的寄存器最高 20 Hz 刷新。"],
                    en: ["Show the bit fields", "Expand CR1. Expanded registers refresh at up to 20 Hz while running."]
                }
            ]
        },
        {
            id: "rtos",
            title: { zh: "FreeRTOS 任务", en: "FreeRTOS tasks" },
            async setup(env) {
                env.sidebar.querySelector(command("debug")).click();
                await env.until(debugging);
                await env.sleep(300);
                env.shell.getElementById("dbgContinue").click();
                await env.sleep(600);
                showEmberProbe(env);
                openSections(env, ["rtosSection"]);
                reveal(env, "rtosSection");
            },
            steps: [
                {
                    target: "#rtosRefresh",
                    done: "click",
                    zh: ["读取任务快照", "目标已暂停在断点。只在暂停时读取。"],
                    en: [
                        "Read a snapshot",
                        "The target is paused at a breakpoint. Snapshots are read only while paused."
                    ]
                },
                {
                    target: ".rtos-task-row:nth-child(2) td:nth-child(2)",
                    done: "click",
                    zh: ["展开任务", "显示 TCB 地址、栈基址和栈使用量。"],
                    en: ["Expand a task", "Shows the TCB address, stack base, and stack use."]
                }
            ]
        },
        {
            id: "memory",
            title: { zh: "内存占用", en: "Memory usage" },
            setup(env) {
                openSections(env, ["memoryAnalysisSection"]);
                reveal(env, "memoryAnalysisSection");
            },
            steps: [
                {
                    target: "#memoryRefresh",
                    done: "click",
                    zh: ["刷新占用", "从 map 文件统计 FLASH、RAM 和各内存区域的占用。"],
                    en: ["Refresh the usage", "Reads FLASH, RAM, and region usage from the map file."]
                },
                {
                    target: ".memory-region:nth-of-type(2)",
                    done: "hover",
                    zh: ["查看区域", "将光标移到内存区域上。"],
                    en: ["Inspect a region", "Move the pointer over a memory region."]
                }
            ]
        },
        {
            id: "chip",
            title: { zh: "芯片信息", en: "Chip information" },
            setup(env) {
                openSections(env, ["chipInfoSection"]);
                reveal(env, "chipInfoSection");
            },
            steps: [
                {
                    target: "#chipRead",
                    done: "click",
                    zh: ["读取芯片信息", "读取内核、器件 ID、Flash 容量和唯一 ID。采样、调试或烧录进行时不能读取。"],
                    en: [
                        "Read the chip",
                        "Reads the core, device ID, Flash size, and unique ID. Not available during sampling, debugging, or flashing."
                    ]
                },
                {
                    target: "#chipMore summary",
                    done: "click",
                    zh: ["展开更多信息", "显示调试连接等其余字段。"],
                    en: ["Show more", "Shows the debug link and the remaining fields."]
                }
            ]
        },
        {
            id: "agent",
            title: { zh: "Agent 配置", en: "Agent setup" },
            setup(env) {
                openSections(env, ["agentConfigSection", "mcpClientsSection"]);
            },
            steps: [
                {
                    target: '[data-client="gemini"] .agent-install',
                    done: "click",
                    zh: ["安装 MCP 服务器", "在侧栏逐个客户端安装。只写用户级配置，所有工程共用一份。"],
                    en: [
                        "Install the MCP server",
                        "Install per client from the sidebar. It writes user-level configuration only, shared by all projects."
                    ]
                },
                {
                    target: '[data-client="codex"] [data-action="upgrade"]',
                    done: "click",
                    zh: ["升级配置", "启动路径或超时过期时显示“可升级”。"],
                    en: ["Upgrade the configuration", "Shows Outdated when the launch path or timeout has changed."]
                },
                {
                    target: "#agentFullAccess",
                    done: "read",
                    zh: ["查看权限开关", "烧录、写入和 CubeMX 生成默认在 Agent 对话中确认。开启此项后不再确认。"],
                    en: [
                        "Review the permission switch",
                        "Flashing, writes, and CubeMX generation are confirmed in the Agent conversation by default. This switch removes the confirmation."
                    ]
                }
            ]
        }
    ];

    if (typeof module === "object") module.exports = { chapters };
    else window.EmberProbeTour = { chapters };
})();
