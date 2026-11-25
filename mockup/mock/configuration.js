(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeMockConfiguration = factory();
})(typeof window === "undefined" ? globalThis : window, function () {
    "use strict";

    const workspace = "C:\\Users\\dev\\EmberProbeDemo\\";
    const debugElf = workspace + "build\\Debug\\EmberProbeDemo.elf";
    const releaseElf = workspace + "build\\Release\\EmberProbeDemo.elf";
    const defaults = {
        elf: debugElf,
        debugger: "jlink.cfg",
        mcu: "stm32f4x.cfg",
        iocPath: workspace + "EmberProbeDemo.ioc"
    };
    const fields = {
        selectElf: ["elf", "msg.searchElf", [debugElf, releaseElf]],
        selectDebugger: ["debugger", "msg.searchDebugger", ["jlink.cfg", "cmsis-dap.cfg", "stlink.cfg"]],
        selectMcuCore: ["mcu", "msg.searchMcu", ["stm32f4x.cfg", "stm32h7x.cfg", "gd32f30x.cfg", "wch-riscv.cfg"]],
        selectIoc: ["iocPath", "cubemx.chooseIoc", [defaults.iocPath, workspace + "EmberProbeDemo.ioc2", ""]]
    };
    const rowCommands = Object.fromEntries(
        Object.entries(fields).map(([command, [field]]) => [field, "mcu-vscode." + command])
    );
    const filename = (value) => value.split(/[\\/]/).at(-1);
    function firmware(iocPath) {
        if (iocPath.endsWith(".ioc2"))
            return { generator: "cubemx2", name: "STM32F4xx_DFP", vendor: "STMicroelectronics", versions: ["2.17.1"] };
        return { generator: "cubemx", name: "STM32Cube F4", versions: ["1.28.0"], hidden: !iocPath };
    }

    function create({ data, quickPick, send, tr, onChange }) {
        const values = { ...defaults };
        const memorySources = new Map();
        function publish() {
            const pack = firmware(values.iocPath);
            const labelKey = pack.generator === "cubemx2" ? "cubemx2.firmwareTitle" : "cubemx.firmwareTitle";
            send({
                type: "mockConfiguration",
                rows: Object.fromEntries(
                    Object.entries(values).map(([field, value]) => [
                        rowCommands[field],
                        { title: value, value: filename(value) }
                    ])
                ),
                notSelected: tr("common.notSelected"),
                firmware: { ...pack, labelKey, label: tr(labelKey) }
            });
            send({ type: "debuggerConfig", debugger: values.debugger });
        }
        function readMemory() {
            const response = data.memoryAnalysis();
            const source = memorySources.get(values.elf) || values.elf.replace(/\.elf$/i, ".map");
            response.result.elf.path = values.elf;
            response.result.source = {
                elf: { path: values.elf },
                ...(source.endsWith(".ld") ? { linkerScript: source } : { mapFile: source })
            };
            return response;
        }
        function selectMemory() {
            const { elf } = values;
            const files = [elf.replace(/\.elf$/i, ".map"), workspace + "STM32F407ZGTx_FLASH.ld"];
            quickPick(
                files.map((path) => ({ label: filename(path), description: path })),
                {
                    title: tr("memory.chooseSource"),
                    matchOnDescription: true
                },
                (selected) => {
                    if (!selected) return;
                    memorySources.set(elf, selected.description);
                    send(readMemory());
                }
            );
        }
        function select(cmd) {
            const [field, key, choices] = fields[cmd.replace("mcu-vscode.", "")];
            quickPick(
                choices.map((value) => ({
                    label: filename(value) || tr("cubemx.clear"),
                    ...(filename(value) !== value ? { description: value } : {}),
                    value
                })),
                { placeHolder: tr(key), matchOnDescription: true },
                (selected) => {
                    if (selected) {
                        values[field] = selected.value;
                        publish();
                        onChange(field);
                    }
                    send({ type: selected ? "commandSuccess" : "commandCancelled", cmd });
                }
            );
        }
        return { select, selectMemory, readMemory, publish, values };
    }
    return { defaults, workspace, filename, firmware, create };
});
