"use strict";
window.EmberProbeSidebarConfiguration = (() => {
    function create({ document, t }) {
        const mcuConfigSection = document.getElementById("mcuConfigSection");
        function configurationIncomplete() {
            if (!mcuConfigSection) return false;
            const commands = ["mcu-vscode.selectElf", "mcu-vscode.selectDebugger", "mcu-vscode.selectMcuCore"];
            if (configName('[data-command="mcu-vscode.selectSamplingBackend"]') === "probe-rs")
                commands.push("mcu-vscode.selectProbeRsChip");
            return commands.some((command) => {
                const row = mcuConfigSection.querySelector(`[data-command="${command}"]`);
                const value = row?.querySelector("small");
                return !value || value.dataset.i18n === "common.notSelected" || !value.textContent.trim();
            });
        }
        // The folded configuration card names the chip family and probe once ELF, debugger and target are all chosen.
        function configName(row) {
            const value = mcuConfigSection?.querySelector(`${row} .row-copy > small`);
            if (!value || value.dataset.i18n === "common.notSelected") return "";
            return value.textContent
                .trim()
                .split(/[\\/]/)
                .pop()
                .replace(/\.cfg$/i, "");
        }
        const PROBE_NAMES = [
            [/^jlink/i, "J-Link"],
            [/^stlink/i, "ST-Link"],
            [/^cmsis-dap/i, "CMSIS-DAP"]
        ];
        function renderConfigSummary() {
            const summary = document.getElementById("mcuConfigSummary");
            if (!summary) return;
            let shown = "";
            if (!configurationIncomplete()) {
                // OpenOCD names targets in lower case ("stm32f4x"); the family reads as STM32F4x.
                const native = configName('[data-command="mcu-vscode.selectSamplingBackend"]') === "probe-rs";
                const chip = configName(
                    `[data-command="${native ? "mcu-vscode.selectProbeRsChip" : "mcu-vscode.selectMcuCore"}"]`
                );
                const probe = configName(".debugger-config-row");
                const family = chip === chip.toLowerCase() ? chip.toUpperCase().replace(/X$/, "x") : chip;
                shown = `${family} · ${PROBE_NAMES.find(([pattern]) => pattern.test(probe))?.[1] || probe}`;
            }
            summary.textContent = shown;
            summary.title = shown;
        }
        // The configuration row's interface script, changed in place by choosing a probe of another family.
        function showDebuggerConfig(name) {
            const value = document.querySelector(".debugger-config-row .row-copy > small");
            if (!value) return;
            value.textContent = name || t("common.notSelected");
            value.title = name;
            if (name) value.removeAttribute("data-i18n");
            else value.setAttribute("data-i18n", "common.notSelected");
            renderConfigSummary();
        }
        function revealIncomplete(e, uiState, api) {
            if (e?.currentTarget?.hasAttribute?.("data-config-free")) return;
            if (!configurationIncomplete() || !mcuConfigSection || mcuConfigSection.open) return;
            mcuConfigSection.open = true;
            uiState.sections ||= {};
            uiState.sections.mcuConfigSection = true;
            api?.setState?.(uiState);
        }
        // An operation that cannot choose a probe opens the list where the user picks one.
        return {
            incomplete: configurationIncomplete,
            revealIncomplete,
            renderSummary: renderConfigSummary,
            showDebugger: showDebuggerConfig
        };
    }
    return { create };
})();
