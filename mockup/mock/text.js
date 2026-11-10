/*
 * Text the mock hosts show on the extension's behalf. Extension strings come from
 * src/i18n (build.js writes them to dist/i18n.js as EmberProbeMockStrings), so
 * picker titles and error messages match the extension; MOCK holds only what the
 * demo firmware itself prints.
 */
(function (root) {
    "use strict";

    var MOCK = {
        zh: {
            "mock.rtt.built": "构建于",
            "mock.rtt.helpHint": "输入 help 查看命令",
            "mock.rtt.cmdHelp": "显示命令列表",
            "mock.rtt.cmdStatus": "打印电机与总线状态",
            "mock.rtt.cmdRpm": "设置目标转速",
            "mock.rtt.cmdVersion": "打印固件版本",
            "mock.dataHit": "数据断点命中"
        },
        en: {
            "mock.rtt.built": "built",
            "mock.rtt.helpHint": "type 'help' for commands",
            "mock.rtt.cmdHelp": "list commands",
            "mock.rtt.cmdStatus": "print motor and bus state",
            "mock.rtt.cmdRpm": "set the target speed",
            "mock.rtt.cmdVersion": "print the firmware version",
            "mock.dataHit": "Data breakpoint hit"
        }
    };

    function create(isEnglish) {
        return function translate(key, params) {
            var lang = isEnglish && isEnglish() ? "en" : "zh";
            var strings = root.EmberProbeMockStrings || {};
            var table = Object.assign({}, strings.zh || {}, strings[lang] || {}, MOCK.zh, MOCK[lang]);
            var text = table[key] != null ? String(table[key]) : key;
            return text.replace(/\{(\w+)\}/g, function (match, name) {
                return params && params[name] != null ? String(params[name]) : match;
            });
        };
    }

    root.EmberProbeMockText = { create: create };
    if (typeof module === "object" && module.exports) module.exports = root.EmberProbeMockText;
})(typeof window !== "undefined" ? window : globalThis);
