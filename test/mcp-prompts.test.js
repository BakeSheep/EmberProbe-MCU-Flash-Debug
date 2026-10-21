"use strict";
// MCP prompts 与 skills 的漂移检查：内容来自 SKILL.md 与 agent-workflow.md，脚本对照表指向真实文件与工具。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const prompts = require("../src/mcp/prompts");
const { TOOLS } = require("../src/mcp/tools");

const root = path.resolve(__dirname, "..", "skills");
const toolNames = new Set(TOOLS.map((tool) => tool.name));

(async () => {
    await scenario("Build every prompt from its skill and the shared workflow", () => {
        assert.strictEqual(prompts.skillsRoot(), root);
        const workflow = fs.readFileSync(path.join(root, "_emberprobe", "agent-workflow.md"), "utf8");
        const failureHandling = prompts.section(workflow, "Failure handling");
        assert.ok(failureHandling.startsWith("## Failure handling") && !failureHandling.includes("\n## "));
        for (const prompt of prompts.PROMPTS) {
            const skill = fs.readFileSync(path.join(root, prompt.skill, "SKILL.md"), "utf8");
            const text = prompts.promptText(prompt, "flash the board");
            assert.ok(text.startsWith("Task: flash the board"));
            assert.ok(
                text.includes(prompts.withoutFrontmatter(skill)),
                `${prompt.name} must embed ${prompt.skill}/SKILL.md`
            );
            assert.ok(!text.includes("\nname: " + prompt.skill), "frontmatter is stripped");
            assert.ok(text.includes(failureHandling));
            for (const [script, tools] of Object.entries(prompt.scripts)) {
                assert.ok(fs.existsSync(path.join(root, prompt.skill, script)), `${prompt.skill}/${script} is missing`);
                assert.ok(skill.includes(script), `${prompt.skill}/SKILL.md no longer names ${script}`);
                for (const name of tools.match(/[a-z]+(?:_[a-z]+)+/g) || [])
                    assert.ok(toolNames.has(name), `${prompt.name} maps ${script} to unknown tool ${name}`);
            }
            assert.deepStrictEqual(Object.keys(prompts.listing(prompt)), ["name", "title", "description", "arguments"]);
        }
        assert.ok(prompts.promptText(prompts.PROMPTS[0]).startsWith(`Task: ${prompts.PROMPTS[0].description}`));
    });

    await scenario("List prompts only for enabled toolsets", () => {
        assert.deepStrictEqual(
            prompts.promptsFor(["core", "debug"]).map((prompt) => prompt.name),
            ["flash", "fault_triage", "variable_debug", "rtos_inspect"]
        );
        assert.deepStrictEqual(
            prompts.promptsFor(["cubemx"]).map((prompt) => prompt.name),
            ["cubemx_generate"]
        );
    });

    console.log("MCP prompt tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
