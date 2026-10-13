"use strict";

// Regenerate test/fixtures/pointer-classes/elf.json from pointer-classes.cpp.
// Requires the Arm GNU Toolchain on PATH; normal tests only read the committed JSON.
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const fixture = path.join(root, "test", "fixtures", "pointer-classes");
const source = path.join(fixture, "pointer-classes.cpp");
const compiler = process.env.ARM_GXX || "arm-none-eabi-g++";
const flags = [
    "-std=c++17",
    "-mcpu=cortex-m4",
    "-mthumb",
    "-O0",
    "-fno-exceptions",
    "-fno-rtti",
    "-fno-unwind-tables",
    "-nostdlib",
    "-Wl,-Ttext=0x08000000,-Tdata=0x20000000,-e,main"
];

function build(version, directory) {
    const output = path.join(directory, `dwarf${version}.elf`);
    childProcess.execFileSync(compiler, [...flags, `-gdwarf-${version}`, source, "-o", output], { stdio: "inherit" });
    return zlib.deflateSync(fs.readFileSync(output), { level: 9 }).toString("base64");
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-pointer-fixture-"));
try {
    const version = childProcess.execFileSync(compiler, ["--version"], { encoding: "utf8" }).split(/\r?\n/)[0];
    const result = {
        compiler: version,
        flags: flags.join(" ").replace("-O0", "-O0 -gdwarf-{4,5}"),
        sources: ["pointer-classes.cpp"],
        format: "zlib-compressed ELF32, base64",
        dwarf4: build(4, directory),
        dwarf5: build(5, directory)
    };
    fs.writeFileSync(path.join(fixture, "elf.json"), JSON.stringify(result, null, 2) + "\n");
    console.log("Wrote test/fixtures/pointer-classes/elf.json");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
