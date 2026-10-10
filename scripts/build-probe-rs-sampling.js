"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const tar = require("tar");

const COMMIT = "48f5e4d53c690a1d40c2454033c6f785b4f4f95c";
const ARCHIVE_SHA256 = "713603c9da1f896730d6837d291d84b84f4b98236184f5e3aee0fe62eaa363a8";
const SERVER_PATH = "probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server";
const BUILD_METADATA = `fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-env=PROBE_RS_VERSION=0.32.0");
    println!("cargo:rustc-env=PROBE_RS_LONG_VERSION=0.32.0 (git commit: ${COMMIT}-emberprobe-sampling-3)");
    println!("cargo:rustc-env=GIT_REV=${COMMIT}");
}
`;

function replaceOnce(source, original, replacement) {
    const index = source.indexOf(original);
    if (index < 0 || source.indexOf(original, index + original.length) >= 0)
        throw new Error("The pinned probe-rs source does not match the sampling patch");
    return source.slice(0, index) + replacement + source.slice(index + original.length);
}

function patchTimerPrecision(startupSource) {
    if (startupSource.includes("struct EmberProbeTimerResolution {"))
        throw new Error("The pinned probe-rs source does not match the sampling patch");
    const stdioStart =
        "pub async fn debug_stdio(\n" +
        "    lister: &Lister,\n" +
        "    log_file: Option<&Path>,\n" +
        "    timestamp_offset: UtcOffset,\n" +
        ") -> Result<()> {\n";
    startupSource = replaceOnce(
        startupSource,
        stdioStart + "    let mut debugger = Debugger::new(timestamp_offset, log_file)?;",
        stdioStart +
            "    let _timer_resolution = EmberProbeTimerResolution::new();\n" +
            "    let mut debugger = Debugger::new(timestamp_offset, log_file)?;"
    );
    return (
        startupSource +
        `

// EmberProbe: request precise Windows waits only for the stdio DAP session.
#[cfg(windows)]
#[link(name = "winmm")]
unsafe extern "system" {
    #[link_name = "timeBeginPeriod"]
    fn emberprobe_time_begin_period(period: u32) -> u32;
    #[link_name = "timeEndPeriod"]
    fn emberprobe_time_end_period(period: u32) -> u32;
}

struct EmberProbeTimerResolution {
    active: bool,
}

impl EmberProbeTimerResolution {
    fn new() -> Self {
        #[cfg(windows)]
        let active = unsafe { emberprobe_time_begin_period(1) } == 0;
        #[cfg(not(windows))]
        let active = false;
        Self { active }
    }
}

impl Drop for EmberProbeTimerResolution {
    fn drop(&mut self) {
        if self.active {
            #[cfg(windows)]
            unsafe { emberprobe_time_end_period(1); }
        }
    }
}

#[cfg(test)]
mod emberprobe_sampling_timer {
    use super::*;

    #[test]
    fn timer_guard_matches_platform() {
        let guard = EmberProbeTimerResolution::new();
        assert_eq!(guard.active, cfg!(windows));
        drop(guard);
    }
}
`
    );
}

function patchJlinkTransfers(source) {
    source = replaceOnce(
        source,
        "use nusb::{DeviceInfo, MaybeFuture, descriptors::TransferType, transfer::Direction};",
        "use nusb::{DeviceInfo, Endpoint, MaybeFuture, descriptors::TransferType,\n" +
            "    transfer::{Bulk, Direction, In, Out}};\n" +
            "use std::cell::RefCell;"
    );
    source = replaceOnce(
        source,
        "use crate::probe::usb_util::InterfaceExt;",
        "use crate::probe::usb_util::{read_bulk_endpoint, write_bulk_endpoint};"
    );
    source = replaceOnce(
        source,
        "    handle: nusb::Interface,\n\n    read_ep: u8,\n    write_ep: u8,",
        "    _handle: nusb::Interface,\n\n" +
            "    // EmberProbe: retain the endpoints for serialized, drained USB transfers.\n" +
            "    read_endpoint: RefCell<Endpoint<Bulk, In>>,\n" +
            "    write_endpoint: RefCell<Endpoint<Bulk, Out>>,"
    );
    source = replaceOnce(
        source,
        "        let mut this = JLink {\n            read_ep,\n            write_ep,",
        "        let read_endpoint = handle.endpoint::<Bulk, In>(read_ep)\n" +
            '            .map_err(|e| open_error(e.into(), "opening J-Link USB input endpoint"))?;\n' +
            "        let write_endpoint = handle.endpoint::<Bulk, Out>(write_ep)\n" +
            '            .map_err(|e| open_error(e.into(), "opening J-Link USB output endpoint"))?;\n' +
            "        let mut this = JLink {\n" +
            "            read_endpoint: RefCell::new(read_endpoint),\n" +
            "            write_endpoint: RefCell::new(write_endpoint),"
    );
    source = replaceOnce(source, "            handle,\n", "            _handle: handle,\n");
    source = replaceOnce(
        source,
        "        let n = self\n" +
            "            .handle\n" +
            "            .write_bulk(self.write_ep, cmd, TIMEOUT_DEFAULT)\n" +
            "            .map_err(JlinkError::Usb)?;",
        "        let n = write_bulk_endpoint(\n" +
            "            &mut self.write_endpoint.borrow_mut(), cmd, TIMEOUT_DEFAULT\n" +
            "        ).map_err(JlinkError::Usb)?;"
    );
    source = replaceOnce(
        source,
        "            let n = self\n" +
            "                .handle\n" +
            "                .read_bulk(self.read_ep, &mut dst[total..], TIMEOUT_DEFAULT)\n" +
            "                .map_err(JlinkError::Usb)?;",
        "            let n = read_bulk_endpoint(\n" +
            "                &mut self.read_endpoint.borrow_mut(), &mut dst[total..], TIMEOUT_DEFAULT\n" +
            "            ).map_err(JlinkError::Usb)?;"
    );
    return source;
}

function patchSources(debuggerSource, startupSource) {
    debuggerSource = replaceOnce(
        debuggerSource,
        "    uploaded_files: Option<UploadedFiles>,",
        "    uploaded_files: Option<UploadedFiles>,\n" +
            "    pub(crate) request_notify: std::sync::Arc<tokio::sync::Notify>,"
    );
    debuggerSource = replaceOnce(
        debuggerSource,
        "            uploaded_files: None,",
        "            uploaded_files: None,\n" +
            "            request_notify: std::sync::Arc::new(tokio::sync::Notify::new()),"
    );
    debuggerSource = replaceOnce(
        debuggerSource,
        "        let error = loop {\n            let debug_session_status =",
        "        let error = loop {\n" +
            "            let notify = self.request_notify.clone();\n" +
            "            let request_ready = notify.notified();\n" +
            "            tokio::pin!(request_ready);\n" +
            "            request_ready.as_mut().enable();\n" +
            "            let debug_session_status ="
    );
    debuggerSource = replaceOnce(
        debuggerSource,
        "                        tokio::time::sleep(delay).await;",
        "                        emberprobe_request_or_idle(request_ready, delay).await;"
    );
    debuggerSource += `

// EmberProbe: preserve idle core/RTT polling, but wake promptly for stdio input.
async fn emberprobe_request_or_idle(request_ready: impl std::future::Future<Output = ()>, delay: Duration) {
    tokio::select! {
        _ = request_ready => {},
        _ = tokio::time::sleep(delay) => {},
    }
}

#[cfg(test)]
mod emberprobe_sampling {
    use super::*;

    #[tokio::test]
    async fn request_before_wait_is_not_lost() {
        let notify = tokio::sync::Notify::new();
        let ready = notify.notified();
        tokio::pin!(ready);
        ready.as_mut().enable();
        notify.notify_waiters();
        let started = std::time::Instant::now();
        emberprobe_request_or_idle(ready, Duration::from_secs(1)).await;
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[tokio::test]
    async fn request_interrupts_idle_wait() {
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let ready = notify.notified();
        tokio::pin!(ready);
        ready.as_mut().enable();
        let sender = notify.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            sender.notify_waiters();
        });
        let started = std::time::Instant::now();
        emberprobe_request_or_idle(ready, Duration::from_secs(1)).await;
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[tokio::test]
    async fn idle_poll_deadline_is_preserved() {
        let notify = tokio::sync::Notify::new();
        let started = std::time::Instant::now();
        emberprobe_request_or_idle(notify.notified(), Duration::from_millis(5)).await;
        assert!(started.elapsed() >= Duration::from_millis(5));
    }
}
`;
    startupSource = replaceOnce(
        startupSource,
        "    let (tx, rx) = mpsc::channel::<Vec<u8>>();",
        "    let (tx, rx) = mpsc::channel::<Vec<u8>>();\n" + "    let request_notify = debugger.request_notify.clone();"
    );
    startupSource = replaceOnce(
        startupSource,
        "                    if tx.send(buf[..n].to_vec()).is_err() {\n" +
            "                        break;\n" +
            "                    }",
        "                    if tx.send(buf[..n].to_vec()).is_err() {\n" +
            "                        break;\n" +
            "                    }\n" +
            "                    request_notify.notify_waiters();"
    );
    startupSource = replaceOnce(
        startupSource,
        "    });\n\n    let reader = ChannelReader::new(rx);",
        "        request_notify.notify_waiters();\n" + "    });\n\n    let reader = ChannelReader::new(rx);"
    );
    return { debuggerSource, startupSource: patchTimerPrecision(startupSource) };
}

function verifyArchive(data) {
    if (crypto.createHash("sha256").update(data).digest("hex") !== ARCHIVE_SHA256)
        throw new Error("The probe-rs source archive failed SHA-256 verification");
}

function runCargo(args, cwd, target) {
    const temp = path.join(path.dirname(target), "temp");
    fs.mkdirSync(temp, { recursive: true });
    const result = spawnSync("cargo", args, {
        cwd,
        env: { ...process.env, CARGO_TARGET_DIR: target, TEMP: temp, TMP: temp, TMPDIR: temp },
        stdio: "inherit",
        shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`cargo ${args[0]} failed (${result.status})`);
}

async function build() {
    const root = path.resolve(__dirname, "..");
    const work = path.join(root, "test-results", "probe-rs-sampling-build");
    const archive = path.join(work, "source.tar.gz");
    const source = path.join(work, "source");
    const target = path.join(work, "target");
    fs.mkdirSync(work, { recursive: true });
    if (!fs.existsSync(archive)) {
        console.log(`Downloading probe-rs 0.32.0 source (${COMMIT})`);
        const response = await fetch(`https://codeload.github.com/probe-rs/probe-rs/tar.gz/${COMMIT}`, {
            signal: AbortSignal.timeout(120000)
        });
        if (!response.ok) throw new Error(`Source download failed (${response.status})`);
        const data = Buffer.from(await response.arrayBuffer());
        verifyArchive(data);
        fs.writeFileSync(archive, data);
    }
    verifyArchive(fs.readFileSync(archive));
    if (!fs.existsSync(path.join(source, "Cargo.toml"))) {
        fs.mkdirSync(source, { recursive: true });
        await tar.x({ file: archive, cwd: source, strip: 1, strict: true });
    }
    const debuggerFile = path.join(source, SERVER_PATH, "debugger.rs");
    const startupFile = path.join(source, SERVER_PATH, "startup.rs");
    const debuggerSource = fs.readFileSync(debuggerFile, "utf8");
    const startupSource = fs.readFileSync(startupFile, "utf8");
    if (!debuggerSource.includes("mod emberprobe_sampling {")) {
        const patched = patchSources(debuggerSource, startupSource);
        fs.writeFileSync(debuggerFile, patched.debuggerSource);
        fs.writeFileSync(startupFile, patched.startupSource);
    } else if (!startupSource.includes("struct EmberProbeTimerResolution {")) {
        fs.writeFileSync(startupFile, patchTimerPrecision(startupSource));
    }
    const jlinkFile = path.join(source, "probe-rs", "src", "probe", "jlink", "mod.rs");
    const jlinkSource = fs.readFileSync(jlinkFile, "utf8");
    if (!jlinkSource.includes("read_endpoint: RefCell<Endpoint<Bulk, In>>"))
        fs.writeFileSync(jlinkFile, patchJlinkTransfers(jlinkSource));
    // A source archive has no .git directory. Keep build.rs from accidentally
    // reporting the surrounding extension repository as the probe-rs revision.
    const metadataFile = path.join(source, "probe-rs-tools", "build.rs");
    if (fs.readFileSync(metadataFile, "utf8") !== BUILD_METADATA) fs.writeFileSync(metadataFile, BUILD_METADATA);
    console.log("Building the request-wakeable stdio DAP server; no probe will be opened");
    const args = ["--release", "--locked", "-p", "probe-rs-tools", "--bin", "probe-rs"];
    runCargo(["build", ...args], source, target);
    runCargo(["test", ...args, "emberprobe_sampling", "--", "--nocapture"], source, target);
    runCargo(["test", "--release", "--locked", "-p", "probe-rs", "probe::jlink", "--", "--nocapture"], source, target);
    const filename = process.platform === "win32" ? "probe-rs.exe" : "probe-rs";
    const executable = path.join(work, "performance-3", filename);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(path.join(target, "release", filename), executable);
    console.log(`Sampling build: ${executable}`);
    console.log(
        "Select this file in emberprobe.probeRsPath for a new session. The installed probe-rs was not changed."
    );
    return executable;
}

if (require.main === module)
    build().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });

module.exports = {
    patchSources,
    patchTimerPrecision,
    patchJlinkTransfers,
    replaceOnce,
    verifyArchive,
    build,
    BUILD_METADATA
};
