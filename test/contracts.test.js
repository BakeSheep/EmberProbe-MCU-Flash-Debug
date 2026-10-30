"use strict";

function runContract(name, test) {
    try {
        test();
    } catch (error) {
        error.message = name + ": " + error.message;
        throw error;
    }
}

// auto-detect.test.js
runContract("auto-detect", () => {
    const assert = require("assert");
    const { probeFromText } = require("../skills/_emberprobe/probe-detection");
    const { targetFromText } = require("../skills/_emberprobe/target-detection");

    assert.strictEqual(probeFromText("CMSIS-DAP v2 Interface"), "cmsis-dap.cfg");
    assert.strictEqual(probeFromText("CMSIS DAP compliant debugger"), "cmsis-dap.cfg");
    assert.strictEqual(probeFromText("USB\\VID_0D28&PID_0204 DAPLink CMSIS-DAP"), "cmsis-dap.cfg");
    assert.strictEqual(probeFromText("MCU-Link CMSIS-DAP V3.128"), "cmsis-dap.cfg");
    assert.strictEqual(probeFromText("Raspberry Pi Picoprobe"), "cmsis-dap.cfg");
    assert.strictEqual(probeFromText("SEGGER J-Link"), "jlink.cfg");
    assert.strictEqual(probeFromText("ST-LINK/V2"), "stlink.cfg");
    assert.strictEqual(probeFromText("Texas Instruments XDS110"), "xds110.cfg");
    assert.strictEqual(probeFromText("Nuvoton Nu-Link"), "nulink.cfg");
    assert.strictEqual(probeFromText("USB Composite Device"), "");

    assert.strictEqual(targetFromText("Project for STM32F407"), "stm32f4x.cfg");
    assert.strictEqual(targetFromText("Project for APM32F407"), "geehy/apm32f4x.cfg");
    assert.strictEqual(targetFromText("Firmware for NRF52840"), "nordic/nrf52.cfg");

    console.log("Auto-detect tests passed");
});

// skill-contract.test.js
runContract("skill-contract", () => {
    // Structural check of how the skills' operation and evidence contracts are wired (not a substitute for behavioural
    // acceptance). It only verifies that the shared reference document exists, is registered in the manifest and is
    // referenced by every SKILL.md, so later edits cannot drop the cross-skill failure handling and result conventions
    // by accident.
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");

    const skillsRoot = path.join(path.resolve(__dirname, ".."), "skills");
    const manifest = JSON.parse(fs.readFileSync(path.join(skillsRoot, "manifest.json"), "utf8"));
    const workflowPath = path.join(skillsRoot, "_emberprobe", "agent-workflow.md");

    assert.ok(fs.existsSync(workflowPath), "skills/_emberprobe/agent-workflow.md must exist");
    assert.ok(
        Array.isArray(manifest.shared) && manifest.shared.includes("agent-workflow.md"),
        "manifest.shared must register agent-workflow.md so install integrity covers it"
    );

    // Every skill must reference the shared workflow document so agents load the common conventions.
    assert.strictEqual(manifest.skills.length, 10, "the extension ships ten agent skills");
    for (const skill of manifest.skills) {
        const skillMd = fs.readFileSync(path.join(skillsRoot, skill.name, "SKILL.md"), "utf8");
        assert.ok(
            skillMd.includes("../_emberprobe/agent-workflow.md"),
            `${skill.name}/SKILL.md must reference the shared agent-workflow.md`
        );
    }

    console.log("Skill contract tests passed");
});

// stl-package-budget.test.js
runContract("stl-package-budget", () => {
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const { deflateRawSync } = require("zlib");

    const root = path.resolve(__dirname, "..");
    const source = fs.readFileSync(path.join(root, "src/debug/stl.js"));
    // Both extension.js and debugAdapter.js contain the display module. Even without
    // compression their combined added code must fit the 0.5 MB release budget.
    assert(source.length * 2 < 500000, "Built-in STL code exceeds the package growth budget");
    const manifest = require("../package.json");
    assert(!manifest.files.some((entry) => /^(?:test|test-results|node_modules)(?:\/|$)/.test(entry)));
    function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            assert(
                !/arm-none-eabi|python|gdb|cpp-debug|xpack-arm/i.test(entry.name),
                "Do not bundle a debugger runtime"
            );
            if (entry.isDirectory()) inspect(path.join(directory, entry.name));
        }
    }
    inspect(path.join(root, "resources"));
    console.log(
        `STL package budget: ${source.length * 2} uncompressed bytes, ${deflateRawSync(source).length * 2} compressed code bytes; no extra runtime`
    );
});
