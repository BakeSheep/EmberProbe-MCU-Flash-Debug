"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");

(async () => {
    await scenario("Scope remembered approval to image identity and revoke pending dialogs on reset", async () => {
        const { HumanApprovalService } = require("../src/services/humanApprovalService");
        function deferred() {
            let resolve;
            const promise = new Promise((done) => {
                resolve = done;
            });
            return { promise, resolve };
        }
        let choice,
            dialogs = 0;
        const state = {};
        const human = new HumanApprovalService(
            {
                window: {
                    showWarningMessage: async () => {
                        dialogs++;
                        return choice;
                    }
                }
            },
            (key) => key,
            {
                get: (key) => state[key],
                update: async (key, value) => {
                    state[key] = value;
                }
            }
        );
        await assert.rejects(human.approve("write", { elf: { sha256: "one" } }), { code: "HUMAN_APPROVAL_DENIED" });
        choice = "approval.workspace";
        await human.approve("write", { elf: { sha256: "one" } }, true);
        const count = dialogs;
        await human.approve("write", { elf: { sha256: "one" }, items: ["other value"] }, true);
        assert.strictEqual(dialogs, count);
        await human.approve("write", { elf: { sha256: "two" } }, true);
        assert.strictEqual(dialogs, count + 1);
        await human.reset("write");
        await human.approve("write", { elf: { sha256: "one" } }, true);
        assert.strictEqual(dialogs, count + 2, "reset must revoke the independent UI permission too");
        const dialog = deferred();
        human.vscode.window.showWarningMessage = () => dialog.promise;
        const approving = human.approve("write", { elf: { sha256: "pending" } }, true);
        await human.reset("write");
        dialog.resolve("approval.workspace");
        await assert.rejects(approving, { code: "HUMAN_APPROVAL_REVOKED" });
    });

    console.log("human-approval tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
