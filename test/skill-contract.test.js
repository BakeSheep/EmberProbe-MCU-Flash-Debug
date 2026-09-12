"use strict";
// 任务1：九个 skills 的操作与证据契约接线校验（结构性，不替代行为验收）。
// 只验证共享参考文档存在、被 manifest 登记，且每个 SKILL.md 都显式引用它，
// 防止后续编辑意外删除跨 skill 的失败处理与结果表达约定。
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

// 九个 skills 必须显式引用共享工作流文档，agent 才能在失败处理时加载统一约定。
assert.strictEqual(manifest.skills.length, 9, "the extension ships nine agent skills");
for (const skill of manifest.skills) {
    const skillMd = fs.readFileSync(path.join(skillsRoot, skill.name, "SKILL.md"), "utf8");
    assert.ok(
        skillMd.includes("../_emberprobe/agent-workflow.md"),
        `${skill.name}/SKILL.md must reference the shared agent-workflow.md`
    );
}

console.log("Skill contract tests passed");
