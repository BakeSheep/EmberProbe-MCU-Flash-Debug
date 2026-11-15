"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { scenario } = require("./helpers/scenario");
const { build } = require("../scripts/build-probe-rs");
const { notices } = require("../scripts/probe-rs-notices");
const { verify, verifyVsix } = require("../scripts/verify-probe-rs");

scenario("native packaging retains binary identity and dependency license text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-native-build-"));
    try {
        const native = path.join(root, "native", "probe-rs", "target", "release");
        fs.mkdirSync(native, { recursive: true });
        const file = "emberprobe-probe-rs" + (process.platform === "win32" ? ".exe" : "");
        fs.writeFileSync(path.join(native, file), "native fixture");
        const pkg = path.join(root, "dependency");
        fs.mkdirSync(pkg);
        fs.writeFileSync(path.join(pkg, "LICENSE-MIT"), "Copyright fixture license");
        fs.mkdirSync(path.join(pkg, "NOTICE-directory"));
        const metadata = {
            packages: [
                { name: "emberprobe-probe-rs" },
                {
                    name: "fixture",
                    version: "1",
                    license: "MIT",
                    manifest_path: path.join(pkg, "Cargo.toml")
                }
            ]
        };
        const calls = [];
        const output = build({
            root,
            cargo: "fake-cargo",
            run: (exe, args) => {
                calls.push([exe, args]);
                return { status: 0, stdout: JSON.stringify(metadata) };
            }
        });
        assert.equal(calls.length, 2);
        assert.ok(calls.every(([, args]) => args.includes("--locked")));
        assert.match(fs.readFileSync(path.join(output, "THIRD_PARTY_NOTICES.txt"), "utf8"), /Copyright fixture/);
        assert.deepEqual(verify(path.dirname(output)), [`${process.platform}-${process.arch}`]);
        assert.throws(() => verify(path.dirname(output), true), /matrix/);
        for (const variant of ["complete", "missing", "tampered"]) {
            const zip = new (require("yazl").ZipFile)();
            const names = [file, "manifest.json", "THIRD_PARTY_NOTICES.txt"];
            if (variant === "missing") names.pop();
            for (const name of names) {
                const bytes =
                    variant === "tampered" && name === file
                        ? Buffer.from("wrong")
                        : fs.readFileSync(path.join(output, name));
                zip.addBuffer(bytes, `extension/resources/probe-rs/${process.platform}-${process.arch}/${name}`, {
                    mode: 0o100755
                });
            }
            const archive = path.join(root, `${variant}.vsix`);
            await new Promise((resolve, reject) => {
                const stream = fs.createWriteStream(archive);
                stream.on("finish", resolve);
                stream.on("error", reject);
                zip.outputStream.on("error", reject);
                zip.outputStream.pipe(stream);
                zip.end();
            });
            if (variant === "complete") await verifyVsix(archive, path.dirname(output));
            else await assert.rejects(verifyVsix(archive, path.dirname(output)), /VSIX native/);
        }
        fs.writeFileSync(path.join(output, file), "tampered");
        assert.throws(() => verify(path.dirname(output)), /identity/);
        assert.throws(() => build({ root, run: () => ({ status: 1 }) }), /failed/);
        assert.throws(() => build({ root, run: () => ({ error: new Error("spawn unavailable") }) }), /unavailable/);
        assert.throws(() => notices({ packages: [{ ...metadata.packages[1], license_file: "../escape" }] }), /escapes/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})
    .then(() => console.log("probe-rs build and packaging tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
