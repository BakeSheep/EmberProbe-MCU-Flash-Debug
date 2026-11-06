"use strict";

const links = {
    github: "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug",
    install: "https://marketplace.visualstudio.com/items?itemName=BakeSheep.emberprobe",
    docs: "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/blob/master/docs/guide/getting-started.md"
};

const content = {
    zh: {
        htmlLang: "zh-CN",
        title: "EmberProbe — 从代码，到芯片",
        description:
            "面向 Cortex-M 的 VS Code 烧录与调试工具。配置连接、固件烧录、断点调试、实时变量与波形，在熟悉的编辑器里完成。",
        nav: ["工作流程", "实时观测", "更多能力", "开始使用"],
        install: "安装到 VS Code",
        demo: "体验交互演示",
        language: "English",
        skip: "跳到正文",
        eyebrow: "CORTEX-M · OPENOCD · VS CODE",
        headline: ["从代码，到芯片。", "让每一步都看得见。"],
        intro: "烧录、调试、实时观测，在熟悉的编辑器里连成一条工作流。少一点来回切换，多一点对运行现场的把握。",
        product: "面向 Cortex-M 的 VS Code 烧录与调试工具",
        caption: "真实产品界面 · 模拟数据",
        zoom: "放大查看界面",
        close: "关闭大图",
        facts: ["一键烧录与校验", "内置断点调试", "实时变量与波形", "Agent / MCP 接入"],
        flowLabel: "一条完整的开发路径",
        flowTitle: "接上探针。\n把想法跑起来。",
        flowIntro: "从找到固件，到看清运行状态，关键操作就在手边。",
        steps: [
            {
                title: "配置连接",
                text: "自动检测工作区 ELF、MCU 目标与已连接探针，确认选择后开始。",
                detail: "ST-Link · CMSIS-DAP · J-Link",
                image: "config",
                alt: "MCU 配置与已连接探针列表"
            },
            {
                title: "烧录校验",
                text: "写入当前固件、校验并复位运行。固件一致时跳过擦写，过程和结果清楚可见。",
                detail: "选择 ELF → 写入 → 校验 → 运行",
                image: "flash",
                alt: "固件烧录按钮与模拟烧录完成通知"
            },
            {
                title: "断点调试",
                text: "在熟悉的 VS Code 中打断点、单步、看调用栈。也可以不复位附加，保留当前现场。",
                detail: "断点 · 单步 · 变量 · 调用栈",
                image: "debug",
                alt: "调试工具栏、源码停止行与变量视图"
            },
            {
                title: "实时观测",
                text: "观察运行时变量和波形，调节参数，再看变化。冻结画面查看历史，按需导出 CSV。",
                detail: "采样 → 调参 → 回读 → 观察",
                image: "wave",
                alt: "实时变量数值与多条采样波形"
            }
        ],
        liveLabel: "让运行状态变得直观",
        liveTitle: "不止看到数值。\n也看见变化。",
        liveIntro: "把变量放到同一条时间线上。观察趋势，调整参数，让下一次判断有据可依。",
        liveNotes: ["结构体、数组与常见 C++ STL 容器展开", "写入后自动回读校验", "冻结查看历史，导出原始采样点"],
        liveLimit: "采样速度取决于探针和会话。不停机写入仅适用于对齐的 32 位变量；其他写入可能需要短暂停机。",
        illustration: "交互示意 · 非硬件实测",
        target: "目标转速",
        measured: "模拟转速",
        freeze: "冻结画面",
        resume: "恢复变化",
        verified: "已回读",
        rpm: "转 / 分",
        moreLabel: "从变量，到整个系统",
        moreTitle: "需要深入时，\n细节也在这里。",
        features: [
            {
                title: "外设寄存器",
                text: "按 SVD 展开寄存器与位域，在暂停时查看和修改。",
                image: "peripheral",
                alt: "外设寄存器及位域"
            },
            {
                title: "FreeRTOS 任务",
                text: "暂停时查看任务状态、优先级和栈信息，理解系统此刻在做什么。",
                image: "rtos",
                alt: "FreeRTOS 任务状态与栈信息"
            },
            {
                title: "内存占用",
                text: "从 ELF 分析 FLASH、RAM 等区域用量，让固件体积一目了然。",
                image: "memory",
                alt: "ELF 内存区域用量"
            },
            {
                title: "Agent / MCP",
                text: "把烧录、变量、调试等能力交给 Agent 调用。烧录、写入和代码生成默认需要确认。",
                image: "agent",
                alt: "Agent Skills 与 MCP 客户端配置"
            }
        ],
        tryLabel: "先试一试，再接上硬件",
        tryTitle: "打开浏览器，\n就能上手。",
        tryText: "在交互演示中开始采样、调整变量、尝试单步调试。使用真实前端和模拟数据，无需安装，也不会连接你的设备。",
        startLabel: "开始你的下一次调试",
        startTitle: "三步，进入工作状态。",
        setup: [
            ["安装扩展", "在 VS Code 1.85+ 中安装 EmberProbe。"],
            ["准备工具", "烧录与采样使用 OpenOCD；断点调试还需要 ARM GDB。"],
            ["连接探针", "连接开发板，使用 Debug 预设构建固件，自动检测并确认配置。"]
        ],
        guide: "阅读配置教程",
        releases: "版本更新",
        issues: "问题反馈",
        source: "源代码",
        license: "MIT 开源",
        footer: "让嵌入式开发，更直观。",
        demoTitle: "EmberProbe 交互演示",
        simulation: "模拟演示，不连接硬件",
        back: "返回官网",
        reset: "重新开始",
        demoHelp:
            "试一试：在侧边栏点击「开始」采样，调整写入列表中的变量；点击「复位调试」后，使用顶部工具栏单步。波形页支持冻结和 CSV 导出。",
        mobileHint: "完整编辑器适合桌面或横屏使用，可横向滚动。",
        standalone: "单独打开编辑器",
        noScript: "交互演示需要启用 JavaScript。首页内容仍可正常阅读。"
    },
    en: {
        htmlLang: "en",
        title: "EmberProbe — From code to Cortex-M",
        description:
            "Flash, debug, and watch Cortex-M firmware in VS Code. Connect your probe, program firmware, step through code, and explore live variables and waveforms.",
        nav: ["Workflow", "Live watch", "Explore", "Get started"],
        install: "Install in VS Code",
        demo: "Try the interactive demo",
        language: "中文",
        skip: "Skip to content",
        eyebrow: "CORTEX-M · OPENOCD · VS CODE",
        headline: ["From code to silicon.", "See every step."],
        intro: "Flash, debug, and watch live data in the editor you already know. Less switching tools. A clearer view of what your firmware is doing.",
        product: "A VS Code flashing and debugging tool for Cortex-M",
        caption: "Actual product UI · Simulated data",
        zoom: "Enlarge interface",
        close: "Close image",
        facts: ["Flash & verify", "Built-in debugging", "Live variables & waveforms", "Agent / MCP integration"],
        flowLabel: "ONE CONNECTED WORKFLOW",
        flowTitle: "Connect your probe.\nBring your code to life.",
        flowIntro: "From finding your firmware to understanding it at runtime, keep the next step close at hand.",
        steps: [
            {
                title: "Connect",
                text: "Detect the workspace ELF, MCU target, and connected probes. Confirm your selection and get started.",
                detail: "ST-Link · CMSIS-DAP · J-Link",
                image: "config",
                alt: "MCU configuration and connected probe selection"
            },
            {
                title: "Flash & verify",
                text: "Program your firmware, verify it, then reset and run. Matching firmware skips erase and write operations.",
                detail: "Select ELF → Write → Verify → Run",
                image: "flash",
                alt: "Flash controls and simulated completion notification"
            },
            {
                title: "Debug",
                text: "Set breakpoints, step through code, and inspect the call stack in VS Code. Attach without reset to preserve the current state.",
                detail: "Breakpoints · Stepping · Variables · Call stack",
                image: "debug",
                alt: "Debug toolbar, stopped source line, and variables"
            },
            {
                title: "Watch live",
                text: "Watch variables and waveforms as firmware runs. Adjust a value, see the change, freeze history, and export CSV.",
                detail: "Sample → Adjust → Read back → Observe",
                image: "wave",
                alt: "Live variable values and sampled waveforms"
            }
        ],
        liveLabel: "A CLEARER VIEW OF RUNTIME",
        liveTitle: "Beyond the numbers.\nSee what changes.",
        liveIntro:
            "Put your variables on a shared timeline. Spot a trend, adjust a parameter, and make your next decision with context.",
        liveNotes: [
            "Explore structs, arrays, and common C++ STL containers",
            "Automatically read back and verify writes",
            "Freeze history and export original samples"
        ],
        liveLimit:
            "Sample rates depend on the probe and session. Only aligned 32-bit writes can keep the target running; other writes may require a brief halt.",
        illustration: "Interactive illustration · No hardware measurements",
        target: "Target speed",
        measured: "Simulated speed",
        freeze: "Freeze view",
        resume: "Resume motion",
        verified: "Read back",
        rpm: "RPM",
        moreLabel: "FROM VARIABLES TO THE SYSTEM",
        moreTitle: "Go deeper.\nThe details are here.",
        features: [
            {
                title: "Peripheral registers",
                text: "Explore SVD registers and bitfields. Read and edit their values while the target is halted.",
                image: "peripheral",
                alt: "Peripheral register values and bitfields"
            },
            {
                title: "FreeRTOS tasks",
                text: "Inspect task states, priorities, and stack information while halted to understand the current system state.",
                image: "rtos",
                alt: "FreeRTOS task states and stack information"
            },
            {
                title: "Memory usage",
                text: "Analyze FLASH, RAM, and other memory regions from your ELF. See where your firmware fits.",
                image: "memory",
                alt: "ELF memory region usage"
            },
            {
                title: "Agent / MCP",
                text: "Let an Agent call flashing, variable, and debugging tools. Flashing, writes, and code generation require confirmation by default.",
                image: "agent",
                alt: "Agent Skills and MCP client configuration"
            }
        ],
        tryLabel: "EXPLORE BEFORE CONNECTING HARDWARE",
        tryTitle: "A browser is\nall you need.",
        tryText:
            "Start sampling, adjust a variable, and step through code. The demo uses the actual frontend with simulated data. No installation or device connection needed.",
        startLabel: "YOUR NEXT DEBUG SESSION STARTS HERE",
        startTitle: "Three steps to get going.",
        setup: [
            ["Install the extension", "Install EmberProbe in VS Code 1.85 or later."],
            ["Prepare your tools", "Flashing and sampling use OpenOCD. Breakpoint debugging also needs ARM GDB."],
            [
                "Connect a probe",
                "Connect your board, build firmware with a Debug preset, then detect and confirm the configuration."
            ]
        ],
        guide: "Read the setup guide (中文)",
        releases: "Releases",
        issues: "Report an issue",
        source: "Source",
        license: "MIT licensed",
        footer: "A clearer view of embedded development.",
        demoTitle: "EmberProbe interactive demo",
        simulation: "Simulation only. No hardware connection.",
        back: "Back to website",
        reset: "Start over",
        demoHelp:
            "Try it: start sampling in the sidebar and adjust a variable in the write list. Start reset debugging, then step using the top toolbar. The waveform panel supports freezing and CSV export.",
        mobileHint: "The full editor works best on desktop or in landscape. Scroll horizontally if needed.",
        standalone: "Open editor separately",
        noScript: "Enable JavaScript to use the interactive demo. The website content is still available without it."
    }
};

module.exports = { content, links };
