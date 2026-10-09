"use strict";

const fs = require("fs");
const path = require("path");

const DEBUG_TYPE = "emberprobe-probe-rs";

function probeRsSettings(vscode) {
    const settings = vscode.workspace.getConfiguration("emberprobe");
    return {
        executable: settings.get("probeRsPath", "probe-rs"),
        chip: settings.get("probeRsChip", ""),
        probe: settings.get("probeRsProbe", ""),
        speed: settings.get("adapterSpeedKhz", 0)
    };
}

function resolveProbeRsDebugConfiguration(config, folder, selectedElf, settings) {
    if (!folder?.uri?.fsPath) throw new Error("Open a workspace folder before starting probe-rs");
    if (!["launch", "attach"].includes(config.request)) throw new Error("probe-rs request must be launch or attach");
    const chip = String(config.chip || settings.chip || "").trim();
    if (!chip || !/^[A-Za-z0-9_.+-]+$/.test(chip))
        throw new Error("Set emberprobe.probeRsChip to a probe-rs chip name, for example STM32H723VG");
    const programBinary = config.coreConfigs?.[0]?.programBinary || config.executable || selectedElf;
    if (!programBinary) throw new Error("Select a Rust ELF executable before starting probe-rs");
    const resolved = path.resolve(folder.uri.fsPath, programBinary);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Debug executable is not a file: ${resolved}`);
    const probe = String(config.probe || settings.probe || "").trim();
    if (probe && !/^[A-Za-z0-9:._-]+$/.test(probe)) throw new Error("Invalid probe-rs probe selector");
    const speed = Number(config.speed ?? settings.speed);
    if (!Number.isInteger(speed) || speed < 0 || speed > 2147483647) throw new Error("Invalid probe speed");
    const coreConfigs =
        Array.isArray(config.coreConfigs) && config.coreConfigs.length
            ? config.coreConfigs.map((core) => ({ ...core }))
            : [{}];
    coreConfigs[0].programBinary = resolved;
    if (config.rttEnabled !== undefined && coreConfigs[0].rttEnabled === undefined)
        coreConfigs[0].rttEnabled = config.rttEnabled;
    if (config.rttChannelFormats !== undefined && coreConfigs[0].rttChannelFormats === undefined)
        coreConfigs[0].rttChannelFormats = config.rttChannelFormats;
    const result = {
        ...config,
        type: DEBUG_TYPE,
        name: config.name || "EmberProbe: probe-rs",
        chip,
        cwd: config.cwd || folder.uri.fsPath,
        coreConfigs,
        flashingConfig: {
            ...(config.flashingConfig || {}),
            flashingEnabled: config.request === "launch" && config.flashingConfig?.flashingEnabled !== false
        }
    };
    if (probe) result.probe = probe;
    if (speed) result.speed = speed;
    delete result.executable;
    delete result.rttEnabled;
    delete result.rttChannelFormats;
    return result;
}

module.exports = { DEBUG_TYPE, probeRsSettings, resolveProbeRsDebugConfiguration };
