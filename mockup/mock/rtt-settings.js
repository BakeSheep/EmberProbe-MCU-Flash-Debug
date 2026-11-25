(function (root) {
    "use strict";

    const order = ["utf-8", "gbk", "gb18030", "big5", "shift_jis", "euc-kr", "latin1"];
    const channelIndex = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
    const modes = ["skip", "trim", "block"];
    const formats = ["text", "raw", "hex"];
    const endings = { lf: "\n", crlf: "\r\n", cr: "\r", none: "" };
    const prefix = "emberprobe.rtt.";
    const defaults = {
        channels: [0],
        autoStart: false,
        encoding: "utf-8",
        virtualTerminals: true,
        "input.mode": "line",
        "input.lineEnding": "lf",
        "logFile.raw": false,
        "logFile.maxBytes": 8388608,
        "logFile.stripAnsi": true
    };

    function isChannel(config) {
        if (channelIndex(config)) return true;
        return (
            config &&
            channelIndex(config.index) &&
            Object.keys(config).every((key) => ["index", "mode", "format", "encoding", "down"].includes(key)) &&
            (config.mode === undefined || modes.includes(config.mode)) &&
            (config.format === undefined || formats.includes(config.format)) &&
            (config.encoding === undefined || order.includes(config.encoding)) &&
            (config.down === undefined || channelIndex(config.down))
        );
    }
    function parse(input) {
        try {
            const value = JSON.parse(input);
            if (!value || Array.isArray(value) || typeof value !== "object") return null;
            const settings = { ...defaults };
            for (const [key, item] of Object.entries(value)) {
                const name = key.slice(prefix.length);
                if (!key.startsWith(prefix) || !Object.hasOwn(defaults, name)) return null;
                if (typeof defaults[name] === "boolean" && typeof item !== "boolean") return null;
                settings[name] = item;
            }
            const { channels, encoding } = settings;
            if (
                !Array.isArray(channels) ||
                !channels.length ||
                channels.length > 16 ||
                !channels.every(isChannel) ||
                new Set(channels.map((entry) => entry.index ?? entry)).size !== channels.length ||
                !order.includes(encoding) ||
                !["line", "raw"].includes(settings["input.mode"]) ||
                !Object.hasOwn(endings, settings["input.lineEnding"]) ||
                !Number.isInteger(settings["logFile.maxBytes"]) ||
                settings["logFile.maxBytes"] < 4 ||
                settings["logFile.maxBytes"] > 16 * 1024 * 1024
            )
                return null;
            return settings;
        } catch {
            return null;
        }
    }
    function json(settings) {
        return JSON.stringify(
            Object.fromEntries(Object.entries(settings).map(([name, value]) => [prefix + name, value]))
        );
    }
    root.EmberProbeMockRttSettings = { defaults, parse, json, endings };
})(typeof window === "undefined" ? globalThis : window);
