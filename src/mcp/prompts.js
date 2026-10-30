"use strict";
// MCP prompts read skills/<name>/SKILL.md and agent-workflow.md shipped with the extension, keeping skills/ the single
// source; a drift test checks the script-to-MCP-tool mapping.
const fs = require("fs");
const path = require("path");

const PROMPTS = Object.freeze([
    {
        name: "flash",
        title: "Flash or verify firmware",
        description: "Program the workspace ELF into the target, or verify on-chip Flash against it.",
        toolset: "core",
        skill: "mcu-flash",
        scripts: { "scripts/program.js": "flash_program", "scripts/verify.js": "flash_verify" }
    },
    {
        name: "fault_triage",
        title: "Diagnose a HardFault",
        description: "Read Cortex-M fault registers and explain the faulting location.",
        toolset: "core",
        skill: "mcu-fault-analyzer",
        scripts: { "scripts/analyze-fault.js": "fault_read" }
    },
    {
        name: "variable_debug",
        title: "Read, trend or tune variables",
        description: "Read or sample firmware variables, add them to the watch list, export history or write one.",
        toolset: "core",
        skill: "mcu-variables",
        scripts: {
            "scripts/read.js": "variables_read, variables_sample, watch_add and variables_export_csv",
            "scripts/sampling.js": "sampling_status and sampling_control",
            "scripts/write.js": "variables_write"
        }
    },
    {
        name: "rtos_inspect",
        title: "Inspect RTOS tasks",
        description: "Snapshot FreeRTOS tasks and inspect a task's stack and locals in a paused session.",
        toolset: "debug",
        skill: "mcu-rtos",
        scripts: { "scripts/rtos.js": "rtos_status, rtos_snapshot and debug_inspect" }
    },
    {
        name: "cubemx_generate",
        title: "Change the .ioc and regenerate code",
        description: "Modify an STM32CubeMX configuration through a candidate .ioc and regenerate initialization code.",
        toolset: "cubemx",
        skill: "mcu-cubemx",
        scripts: {
            "scripts/cubemx.js":
                "the cubemx_* tools. cubemx_prepare returns the plan without a confirmation ID; cubemx_execute and cubemx_start ask the user for approval themselves, so pass confirmationId only when one of them returned it"
        }
    }
]);

// Packaged code lives in dist/ and source runs from src/mcp/; find the extension's skills directory in both layouts.
function skillsRoot() {
    for (const candidate of [path.join(__dirname, "..", "skills"), path.join(__dirname, "..", "..", "skills")])
        if (fs.existsSync(path.join(candidate, "_emberprobe", "agent-workflow.md"))) return candidate;
    throw Object.assign(new Error("EmberProbe skills directory not found"), { code: "SKILLS_NOT_FOUND" });
}

function withoutFrontmatter(text) {
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function section(markdown, heading) {
    const start = markdown.indexOf(`\n## ${heading}\n`);
    if (start < 0) return "";
    const rest = markdown.slice(start + 1);
    const end = rest.indexOf("\n## ", 4);
    return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function promptText(prompt, goal, root = skillsRoot()) {
    const skill = withoutFrontmatter(fs.readFileSync(path.join(root, prompt.skill, "SKILL.md"), "utf8"));
    const workflow = fs.readFileSync(path.join(root, "_emberprobe", "agent-workflow.md"), "utf8");
    const mapping = Object.entries(prompt.scripts).map(([script, tools]) => `- \`${script}\` → ${tools}`);
    return [
        goal ? `Task: ${goal}` : `Task: ${prompt.description}`,
        "",
        `Use the EmberProbe MCP tools. The guide below is the EmberProbe "${prompt.skill}" Agent Skill. Where it names a script, call the matching MCP tool instead and pass its CLI options as the tool's input fields:`,
        ...mapping,
        "Approval, probe ownership and evidence rules apply unchanged; approval must come from the user.",
        "",
        skill,
        "",
        section(workflow, "Failure handling")
    ].join("\n");
}

function listing(prompt) {
    return {
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: [{ name: "goal", description: "What the user wants, in their words", required: false }]
    };
}

function promptsFor(toolsets) {
    const enabled = new Set(toolsets);
    return PROMPTS.filter((prompt) => enabled.has(prompt.toolset));
}

module.exports = { PROMPTS, promptsFor, promptText, listing, skillsRoot, withoutFrontmatter, section };
