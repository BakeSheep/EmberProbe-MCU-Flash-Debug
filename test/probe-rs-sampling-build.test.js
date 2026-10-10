"use strict";

const assert = require("assert");
const {
    patchSources,
    patchTimerPrecision,
    patchJlinkTransfers,
    replaceOnce,
    verifyArchive,
    BUILD_METADATA
} = require("../scripts/build-probe-rs-sampling");

const debuggerSource = [
    "    uploaded_files: Option<UploadedFiles>,",
    "            uploaded_files: None,",
    "        let error = loop {",
    "            let debug_session_status =",
    "                        tokio::time::sleep(delay).await;",
    "        tokio::time::sleep(Duration::from_millis(500)).await;"
].join("\n");
const startupSource = [
    "pub async fn debug_stdio(",
    "    lister: &Lister,",
    "    log_file: Option<&Path>,",
    "    timestamp_offset: UtcOffset,",
    ") -> Result<()> {",
    "    let mut debugger = Debugger::new(timestamp_offset, log_file)?;",
    "",
    "    let old_hook = std::panic::take_hook();",
    "    let (tx, rx) = mpsc::channel::<Vec<u8>>();",
    "    std::thread::spawn(move || {",
    "        loop {",
    "                    if tx.send(buf[..n].to_vec()).is_err() {",
    "                        break;",
    "                    }",
    "        }",
    "    });",
    "",
    "    let reader = ChannelReader::new(rx);"
].join("\n");

const result = patchSources(debuggerSource, startupSource);
assert.match(result.debuggerSource, /request_notify: std::sync::Arc<tokio::sync::Notify>/);
assert.match(result.debuggerSource, /request_ready\.as_mut\(\)\.enable\(\);\n\s+let debug_session_status/);
assert.match(result.debuggerSource, /emberprobe_request_or_idle\(request_ready, delay\)\.await/);
assert.match(result.debuggerSource, /_ = request_ready => \{\}/);
assert.match(result.debuggerSource, /_ = tokio::time::sleep\(delay\) => \{\}/);
assert.match(result.debuggerSource, /tokio::time::sleep\(Duration::from_millis\(500\)\)\.await/);
assert.match(result.startupSource, /request_notify = debugger.request_notify.clone\(\)/);
assert.equal(result.startupSource.match(/request_notify\.notify_waiters\(\)/g).length, 2);
assert.match(result.startupSource, /tx\.send[\s\S]+request_notify\.notify_waiters/);
assert.match(result.startupSource, /request_notify\.notify_waiters\(\);\n\s+\}\);/);
assert.match(result.startupSource, /_timer_resolution = EmberProbeTimerResolution::new\(\);\n\s+let mut debugger/);
assert.match(result.startupSource, /let active = unsafe \{ emberprobe_time_begin_period\(1\) \} == 0/);
assert.match(
    result.startupSource,
    /impl Drop for EmberProbeTimerResolution[\s\S]+if self.active[\s\S]+emberprobe_time_end_period\(1\)/
);
assert.match(result.startupSource, /#\[cfg\(not\(windows\)\)\]\n\s+let active = false/);
assert.match(result.startupSource, /fn timer_guard_matches_platform/);
assert.match(result.debuggerSource, /async fn request_before_wait_is_not_lost/);
assert.match(result.debuggerSource, /async fn request_interrupts_idle_wait/);
assert.match(result.debuggerSource, /async fn idle_poll_deadline_is_preserved/);
assert.throws(() => patchSources("unsupported source", startupSource), /does not match/);
assert.throws(() => patchSources(debuggerSource, "unsupported source"), /does not match/);
assert.throws(() => patchSources(result.debuggerSource, result.startupSource), /does not match/);
assert.throws(() => patchTimerPrecision(result.startupSource), /does not match/);
assert.throws(() => patchTimerPrecision("unsupported source"), /does not match/);
const jlinkSource = [
    "use nusb::{DeviceInfo, MaybeFuture, descriptors::TransferType, transfer::Direction};",
    "use crate::probe::usb_util::InterfaceExt;",
    "    handle: nusb::Interface,",
    "",
    "    read_ep: u8,",
    "    write_ep: u8,",
    "        let mut this = JLink {",
    "            read_ep,",
    "            write_ep,",
    "            handle,",
    "        let n = self",
    "            .handle",
    "            .write_bulk(self.write_ep, cmd, TIMEOUT_DEFAULT)",
    "            .map_err(JlinkError::Usb)?;",
    "        if n != cmd.len() { return Err(incomplete_write); }",
    "        let needs_workaround = buf.len().is_multiple_of(self.max_read_ep_packet);",
    "        while total < len {",
    "            let n = self",
    "                .handle",
    "                .read_bulk(self.read_ep, &mut dst[total..], TIMEOUT_DEFAULT)",
    "                .map_err(JlinkError::Usb)?;",
    "            total += n;",
    "        }",
    "        self.unregister_connection().ok();"
].join("\n");
const patchedJlink = patchJlinkTransfers(jlinkSource);
assert.match(patchedJlink, /read_endpoint: RefCell<Endpoint<Bulk, In>>/);
assert.match(patchedJlink, /write_endpoint: RefCell<Endpoint<Bulk, Out>>/);
assert.equal(patchedJlink.match(/handle\.endpoint::/g).length, 2);
assert.match(patchedJlink, /read_bulk_endpoint\([\s\S]+dst\[total\.\.\], TIMEOUT_DEFAULT/);
assert.match(patchedJlink, /write_bulk_endpoint\([\s\S]+cmd, TIMEOUT_DEFAULT/);
assert.doesNotMatch(patchedJlink, /\.read_bulk\(|\.write_bulk\(/);
assert.match(patchedJlink, /if n != cmd.len\(\)/);
assert.match(patchedJlink, /needs_workaround = buf.len\(\).is_multiple_of\(self.max_read_ep_packet\)/);
assert.match(patchedJlink, /self.unregister_connection\(\).ok\(\)/);
assert.throws(() => patchJlinkTransfers("unsupported source"), /does not match/);
assert.throws(() => patchJlinkTransfers(patchedJlink), /does not match/);
assert.throws(() => patchJlinkTransfers(jlinkSource + "\n" + jlinkSource), /does not match/);
assert.throws(() => replaceOnce("duplicate duplicate", "duplicate", "patched"), /does not match/);
assert.throws(() => verifyArchive(Buffer.from("unverified downloaded source")), /SHA-256/);
assert.match(BUILD_METADATA, /48f5e4d53c690a1d40c2454033c6f785b4f4f95c-emberprobe-sampling/);
assert.doesNotMatch(BUILD_METADATA, /Command|git_version!/);
console.log("probe-rs sampling source pinning, wake registration and patch validation tests passed");
