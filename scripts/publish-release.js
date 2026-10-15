"use strict";
const { execFileSync } = require("child_process");
function publishRelease(
    tag,
    run = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    options = {}
) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("A stable release tag is required");
    let release = null;
    try {
        release = JSON.parse(run(["release", "view", tag, "--json", "isDraft"]));
    } catch (error) {
        if (!/release not found|HTTP 404/i.test(String(error.stderr || error.message))) throw error;
    }
    if (release && !release.isDraft) {
        if (options.replaceAsset !== true) return { published: false, reason: "already-public" };
        run(["release", "upload", tag, "dist/emberprobe.vsix", "--clobber"]);
        return { published: true, replaced: true };
    }
    if (release) run(["release", "edit", tag, "--draft", "--title", "EmberProbe " + tag]);
    else run(["release", "create", tag, "--verify-tag", "--draft", "--generate-notes", "--title", "EmberProbe " + tag]);
    run(["release", "upload", tag, "dist/emberprobe.vsix", "--clobber"]);
    run(["release", "edit", tag, "--draft=false"]);
    return { published: true };
}
if (require.main === module) {
    try {
        console.log(
            publishRelease(process.env.RELEASE_TAG, undefined, {
                replaceAsset: process.env.REPLACE_RELEASE_ASSET === "true"
            })
        );
    } catch (error) {
        console.error(error.stderr?.toString() || error);
        process.exitCode = 1;
    }
}
module.exports = { publishRelease };
