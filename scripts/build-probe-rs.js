"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { notices } = require("./probe-rs-notices");

function build({ root = path.resolve(__dirname, ".."), cargo = process.env.CARGO || "cargo", run = spawnSync } = {}) {
    const manifest = path.join(root, "native", "probe-rs", "Cargo.toml");
    const result = run(cargo, ["build", "--release", "--locked", "--manifest-path", manifest], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native sampler build failed (${result.status})`);
    const name = "emberprobe-probe-rs" + (process.platform === "win32" ? ".exe" : "");
    const source = path.join(root, "native", "probe-rs", "target", "release", name);
    const output = path.join(root, "resources", "probe-rs", `${process.platform}-${process.arch}`);
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(source, path.join(output, name));
    if (process.platform !== "win32") fs.chmodSync(path.join(output, name), 0o755);
    const bytes = fs.readFileSync(source);
    const identity = {
        protocol: 1,
        library: "probe-rs 0.32.0",
        file: name,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    };
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(identity, null, 2) + "\n");
    const metadata = run(cargo, ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
    });
    if (metadata.error || metadata.status !== 0) throw metadata.error || new Error("Cargo license metadata failed");
    fs.writeFileSync(path.join(output, "THIRD_PARTY_NOTICES.txt"), notices(JSON.parse(metadata.stdout)));
    console.log(`Native sampler staged: ${output}`);
    return output;
}
if (require.main === module) {
    try {
        build();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { build };
