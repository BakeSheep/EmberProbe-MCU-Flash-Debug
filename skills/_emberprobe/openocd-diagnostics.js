"use strict";
function connectionDetails(options) {
    return {
        probe: options.probe,
        target: options.target,
        transport: options.transport || "auto",
        probeSerial: options.probeSerial || "",
        adapterSpeedKhz: options.adapterSpeedKhz || 0,
        ...(options.inventory ? { inventory: options.inventory } : {})
    };
}

function parseTargetVoltage(line) {
    const match = String(line || "").match(/(?:target voltage|vtarget)\s*:?\s*=?\s*(\d+(?:\.\d+)?)/i);
    return match ? Number(match[1]) : null;
}

// 将 OpenOCD 原始日志归一化为稳定的机器可读诊断，供 UI 与 Agent Skills 共用。
// 匹配顺序很重要：目标芯片未连接与调试器未找到是两类完全不同的故障。
function diagnoseOpenOcdFailure(lines, details = {}) {
    const retained = (Array.isArray(lines) ? lines : [lines])
        .map((line) =>
            String(line || "")
                .replace(/\x1b\[[0-9;]*m/g, "")
                .trim()
        )
        .filter(Boolean);
    const tail = retained.slice(-8).map((line) => line.slice(0, 500));
    const text = retained.join("\n").toLowerCase();
    const platform = details.platform || process.platform;
    const usbActions = ["检查探针 USB 连接、所选序列号与实际接口。"];
    const driverActions = [...usbActions];
    if (platform === "win32") {
        driverActions.push(
            /j[- ]?link/i.test(details.probe || "")
                ? "旧款 J-Link 的 SEGGER 驱动可能与 OpenOCD 不兼容；核对实际 USB 接口与驱动绑定。替换驱动可能影响原有 SEGGER 工具，请先确认型号和恢复方法。"
                : "核对探针型号与 USB 驱动绑定，勿直接替换其他 USB 接口的驱动。"
        );
    } else if (platform === "linux") {
        driverActions.push("检查 OpenOCD udev 规则和当前用户的设备访问权限。");
    } else {
        driverActions.push("检查系统是否识别探针，以及其他调试软件是否占用设备。");
    }
    const make = (code, category, likelyCause, suggestedActions, retryable = true) => ({
        code,
        category,
        stage: "openocd_start",
        message: likelyCause,
        likelyCause,
        retryable,
        suggestedActions,
        details: { ...details, openocdTail: tail }
    });
    if (
        /transport.*(?:not supported|unsupported|invalid|not available|can't|cannot)|(?:can't|cannot|unable to|doesn't support).*transport/.test(
            text
        )
    ) {
        return make(
            "OPENOCD_TRANSPORT_INVALID",
            "configuration",
            "所选传输协议不受探针或 OpenOCD 配置支持。",
            ["检查 emberprobe.transport；按实际接线明确选择受支持的 SWD/JTAG 协议。"],
            false
        );
    }
    // USB root causes take precedence over the generic init/target failure that follows.
    if (/libusb_error_busy|(?:usb|device).*(?:resource busy|already in use)/.test(text)) {
        return make(
            "PROBE_BUSY",
            "resource_conflict",
            "调试探针正被其他程序占用。",
            ["结束 Ozone、J-Link Commander 或其他程序中使用该探针的会话，再手动重试。"],
            false
        );
    }
    if (
        /libusb_error_access|libusb.*(?:access|permission)|access denied|permission denied|usb_open.*access/.test(text)
    ) {
        return make(
            "PROBE_PERMISSION_DENIED",
            "probe_connection",
            "操作系统拒绝访问调试探针。",
            [
                platform === "linux"
                    ? "检查 OpenOCD udev 规则和当前用户的设备访问权限。"
                    : "检查设备访问权限和占用情况。"
            ],
            false
        );
    }
    if (/libusb_error_no_device/.test(text)) {
        return make("PROBE_DISCONNECTED", "probe_connection", "USB 探针已断开或设备已不可用。", usbActions, false);
    }
    if (/libusb_error_not_supported/.test(text)) {
        return make(
            "PROBE_DRIVER_UNSUPPORTED",
            "probe_connection",
            "当前 USB 驱动或接口不支持 OpenOCD 所需的访问方式。",
            driverActions,
            false
        );
    }
    if (/libusb_error_not_found/.test(text)) {
        return make(
            "PROBE_NOT_FOUND",
            "probe_connection",
            "OpenOCD 无法打开所需 USB 设备或接口；需核对连接与驱动。",
            [...usbActions, "核对设备是否断开、接口选择与驱动绑定；未找到设备不能单独证明驱动不兼容。"],
            false
        );
    }
    if (
        /(can't find|cannot find|no such file|unknown command|invalid command).*(\.cfg|interface|target)|\.cfg.*(can't find|cannot find)/.test(
            text
        )
    ) {
        return make(
            "OPENOCD_CONFIG_INVALID",
            "configuration",
            "OpenOCD 找不到探针或目标配置脚本。",
            ["检查 EmberProbe 中的调试器与 MCU 目标配置。", "确认 openocdPath 指向完整的 OpenOCD 安装。"],
            false
        );
    }
    if (/address already in use|couldn't bind|can't bind|error .*binding/.test(text)) {
        return make("TCL_PORT_IN_USE", "resource_conflict", "OpenOCD Tcl 端口已被其他进程占用。", [
            "关闭残留的 OpenOCD 或其他调试会话后重试。",
            "必要时在 EmberProbe 配置中更换 Tcl 端口。"
        ]);
    }
    // Probe/open failures must win over the generic 'init failed' that follows.
    if (
        /no (?:j-?link|.*probe).*?(?:device )?found|unable to find.*(?:cmsis|dap|st-?link|j-?link|probe)|no device found|libusb_open.*(?:not found|no device)/.test(
            text
        )
    ) {
        return make(
            "PROBE_NOT_FOUND",
            "probe_connection",
            "OpenOCD 未找到或无法访问所选调试探针。",
            [...usbActions, "关闭可能占用探针的其他调试会话；核对驱动，但不要仅凭此错误替换驱动。"],
            false
        );
    }
    if (/(?:failed|unable) to open.*(?:probe|device)|open failed.*(?:probe|device)/.test(text)) {
        return make(
            "PROBE_OPEN_FAILED",
            "probe_connection",
            "OpenOCD 无法打开调试探针；原因尚未确定。",
            [...usbActions, "保留打开失败的原始日志，分别核对权限、占用和驱动兼容性。"],
            false
        );
    }
    const voltages = retained.map(parseTargetVoltage).filter((volts) => volts !== null);
    if (
        voltages.some((volts) => volts <= 0.5) ||
        /voltage.*too low|unpowered|not powered|target power.*(?:off|low)/.test(text)
    ) {
        return make("TARGET_UNPOWERED", "target_connection", "探针报告参考电压过低；需核对目标供电与测量能力。", [
            "检查目标板电源。",
            "检查探针 VTref/GND 接线；J-Link OB 测量能力未知时，零读数不能单独证明目标断电。"
        ]);
    }
    if (
        /cannot read idr|error connecting dp|target not examined|init failed|no target connected|dp initialisation failed|unable to connect to target|jtag scan chain interrogation failed|all ones|all zeroes/.test(
            text
        )
    ) {
        return make(
            "TARGET_NOT_CONNECTED",
            "target_connection",
            "调试器已启动，但无法与目标 MCU 建立 SWD/JTAG 连接。",
            [
                "检查 MCU 供电以及 SWDIO/SWCLK/GND/NRST 接线。",
                "确认所选 MCU target 配置与实际芯片一致。",
                "可尝试降低 adapter speed 后重试。"
            ]
        );
    }
    if (/timed? ?out|timeout/.test(text)) {
        return make("OPENOCD_CONNECTION_TIMEOUT", "connection_timeout", "OpenOCD 与探针或目标 MCU 通信超时。", [
            "检查 USB、目标供电和调试接线。",
            "降低 adapter speed 后重试。"
        ]);
    }
    if (/ep_verify fail|verification failed|verify.*failed/.test(text)) {
        return make(
            "FLASH_VERIFY_FAILED",
            "verification",
            "固件校验失败。",
            ["检查原始校验输出、固件与目标配置。"],
            false
        );
    }
    if (/protected|read out protection|\brdp\b|option byte/.test(text)) {
        return make(
            "TARGET_PROTECTED",
            "target_configuration",
            "目标可能启用了读写保护。",
            ["核对芯片保护状态；解除保护或擦除可能丢失数据，需单独确认。"],
            false
        );
    }
    if (/flash write failed|failed erasing|failed to write|error writing|error erasing|write discontinued/.test(text)) {
        return make(
            "FLASH_WRITE_FAILED",
            "flash",
            "Flash 写入或擦除失败。",
            ["检查供电稳定性、写保护及目标配置。"],
            false
        );
    }
    return make(
        "OPENOCD_START_FAILED",
        "openocd",
        tail
            .slice()
            .reverse()
            .find((line) => /\berror\b|failed|unable|denied/i.test(line)) || "OpenOCD 未能建立采样连接。",
        ["检查诊断中的 openocdTail 原始输出。", "确认探针、目标板供电、接线和 EmberProbe 配置。"]
    );
}

function hintForErrors(lines, details = {}) {
    const result = diagnoseOpenOcdFailure(lines, details);
    return result.suggestedActions.join(" ");
}

module.exports = { diagnoseOpenOcdFailure, hintForErrors, parseTargetVoltage, connectionDetails };
