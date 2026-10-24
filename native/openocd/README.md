# OpenOCD scatter-read prototype

Opt-in P2 experiment based on upstream OpenOCD
[`e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3`](https://github.com/openocd-org/openocd/tree/e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3),
the revision used by xPack **0.12.0-7**. The bundled archives and target manifest
remain official xPack files. This build is separate from release automation.

## Command and design

```tcl
emberprobe_read_scatter version
# 1, on an examined Cortex-M target with a debug MEM-AP
emberprobe_read_scatter {0x20000001 8 3} {0x20000102 16 1} {0x20000400 32 2}
[target current] emberprobe_read_scatter {0x20000000 32 1}
```

The result has one lowercase, memory-order hex line per segment, without a
trailing newline. Both registrations follow `read_memory` and respect the
selected target. Limits: 1–64 aligned segments, widths 8/16/32, positive counts,
4096 bytes total. Invalid arguments fail before reads. HLA, unexamined targets,
RISC-V and targets without a Cortex-M MEM-AP return errors beginning with
`EMBERPROBE_SCATTER_UNSUPPORTED`.

The GPL patch adds `mem_ap_read_scatter()` and its segment interface in
`arm_adi_v5.c/.h`, plus a handler and two registrations in `target.c`. It uses
`target_to_armv7m_safe()` (parent ARM magic and `is_armv7m()`), rejects HLA, and
reads `debug_ap` like `cortex_m_read_memory()`. Natural alignment preserves the
ARMv6-M restriction. There is no M7/M33 cache maintenance, halt or reset.

CSW/TAR changes use the existing cache helpers. TAR boundaries use
`max_tar_block_size()` and `mem_ap_update_tar_cache()`. Confirmed packed modes
use the same packing conditions and byte lanes as `mem_ap_read()`, including
the TI BE-32 lane quirk. Unknown widths/packing queue CSW readbacks in the **same
flush**, initially using single transfers; successful readback updates the
capability caches. Saved transfer sizes keep unpacking independent of later
cache updates. Unsupported widths fail without partial results.

`dap_queue_ap_read()` retains posted-read handling across segments and CSW/TAR
switches. Raw destinations remain allocated until the single `dap_run()` returns,
including queueing-error cleanup. Normal DAP sticky-error recovery runs there;
failures invalidate CSW/TAR and propagate. There is no second TAR read to recover
partial data. Buffers are freed on every path. One logical DAP flush may still
require multiple adapter packets due to transport limits: this does not promise
one USB packet or physical network transaction.

The C patch is **GPL-2.0-or-later**, derived from OpenOCD. Preserve its license
and upstream notices, and provide corresponding source as required when
distributing modified binaries. The extension's license is unchanged. xPack's
output includes dependency license files.

## Build inside WSL Ubuntu x86_64

```sh
export EMBERPROBE_OPENOCD_BUILD_DIR="$HOME/.cache/emberprobe-openocd"
bash native/openocd/build.sh
```

The script uses native actions from
[`openocd-xpack` tag `v0.12.0-7`](https://github.com/xpack-dev-tools/openocd-xpack/tree/v0.12.0-7),
revision `10eb7ea34d422bc3405d1b322952ef4a68c84cc4`, with xpm 0.20.5. There are
no `README-MAINTAINER*.md` files at that tag; instructions moved to
[`website/docs/maintainer`](https://github.com/xpack-dev-tools/openocd-xpack/tree/v0.12.0-7/website/docs/maintainer).
Actions and toolchain versions are in
[`build-assets/package.json`](https://github.com/xpack-dev-tools/openocd-xpack/blob/v0.12.0-7/build-assets/package.json);
recipes are in `build-assets/scripts/`. Both `xpm run build --config win32-x64`
(MinGW cross build) and `--config linux-x64` run on Linux. Docker is an optional
wrapper, so a separate upstream configure-based fallback is unnecessary.

The wrapper keeps xPack's dependency recipes and drivers: GCC 14.2.0-2.1,
MinGW GCC 14.2.0-1.1, libusb 1.0.29, hidapi 0.15.0, libftdi 1.5, internal
JimTcl/libjaylink, and the xPack greeting. It drops the patch into the helper's
conventional `build-assets/patches/` directory and inserts an apply hook after
OpenOCD download, before bootstrap; this tag has no OpenOCD patch hook.

Prerequisites: gcc/make/autoconf/automake/pkg-config/git/node/npm and standard
Ubuntu tools (patch, tar, curl/wget, xz, zip/unzip, lsb-release, realpath, flock,
apt-get and dpkg-deb). xpm supplies the additional build tools. Apt indexes and
network access must be available. No sudo or system package installation is
used: libudev development/runtime debs are downloaded and extracted locally.
The helper's libudev copy uses those files. xPack's build smoke tests (which start
`openocd.exe` through Wine) and Wine priming are disabled; check the Windows
binary on a Windows host instead. All downloads,
npm/xpm stores, workspaces and temporary files stay under the build cache, which
must be outside the repo without spaces or shell metacharacters (xPack scripts
also contain unquoted paths). A lock prevents overlapping builds. The workspace is keyed by the patch hash, so
script-only fixes reuse finished components; a changed patch gets a fresh workspace.

This follows the official recipes but is **not a reproducible official release**:
Ubuntu 26.04 replaces the XBB container baseline, libudev versions follow apt
indexes, and xPack updates submodules with `--remote`. `BUILD-INFO.txt` records
the actual submodule revisions, deb hashes, source revision, patch/build-script
SHA256 and configuration. Keep cache/build logs for repeat comparisons.

Checked so far (2026-10-24, WSL Ubuntu 26.04 host): the patch compiles in the
win32-x64 and linux-x64 builds. The Linux binary registers the command and returns
the unsupported error for the same dummy target. On Windows the binary reports `0.12.0+dev-02228-ge5888bda3`,
registers both command forms after `init`, returns the `EMBERPROBE_SCATTER_UNSUPPORTED`
error for an unexamined dummy Cortex-M target, and passes EmberProbe's no-echo
self-test.

Read-only board comparison (2026-10-24, Windows 11, 16 scattered RAM globals from
each firmware ELF, unlimited mode, 10 s, SWD at the target script's default clock,
same EmberProbe build; stock = official xPack 0.12.0-7):

| Board / probe | Stock | Patched | Tcl RPCs per cycle |
| --- | --- | --- | --- |
| APM32F407 + J-Link V9 | 191.3 Hz, p50 5.20 ms, p95 5.76 ms | 394.4 Hz, p50 2.50 ms, p95 2.78 ms | 2 → 1 |
| STM32H750 + CMSIS-DAP v1 (HID) | 30.6 Hz, p50 32.0 ms, p95 34.0 ms | 81.0 Hz, p50 12.0 ms, p95 14.0 ms | 2 → 1 |

A same-connection check alternated 60 scatter and 60 ordinary reads of those 16
globals plus four unaligned 2/3-byte slices: every variable that held one value
across all reads (18/20 on the F407, 11/20 on the H750) matched byte for byte;
the rest change in both paths (task pointers, list counts, signal channels). No
writes, halts, resets or programming were performed. Other probes, wireless
CMSIS-DAP and Linux hosts have not been measured.
A wider matrix (clustered fields, 32 variables, 1 KB blocks, fixed target rates and
a higher sampling clock, compared with the pre-P0 baseline) is in
[`docs/UNLIMITED-SAMPLING.md`](../../docs/UNLIMITED-SAMPLING.md).

Outputs, including required DLLs/libraries and licenses:

```text
test-results/openocd-scatter/win32-x64/bin/openocd.exe
test-results/openocd-scatter/win32-x64/openocd/scripts/
test-results/openocd-scatter/win32-x64/BUILD-INFO.txt
test-results/openocd-scatter/linux-x64/bin/openocd
test-results/openocd-scatter/linux-x64/openocd/scripts/
test-results/openocd-scatter/linux-x64/BUILD-INFO.txt
```

Only these output trees are written inside the repo. For a separate source build,
check out the base revision and use `git am /path/to/0001-emberprobe-read-scatter.patch`
or `patch -p1 < /path/to/0001-emberprobe-read-scatter.patch`.

## Opt in and fallback

Set `emberprobe.openocdPath` to the output `bin/openocd.exe` or `bin/openocd`;
keep its sibling scripts/libraries in place and reconnect sampling. After the
no-echo self-test, each Tcl connection checks `emberprobe_read_scatter version`;
exactly `1` enables it. Because the command refuses until the target has been
examined, an `EMBERPROBE_SCATTER_UNSUPPORTED` answer at connect is asked once more
after the first fully successful sampling cycle. `stats().scatterReads` reports
its current state. Stock
OpenOCD continues using ordinary batches. No new setting is added.

Fixed-address compiler units are combined into as few bounded calls as possible.
Runtime objects retain the existing reader and budgets. Strict hex validation
rejects extra/missing lines, wrong lengths, uppercase and non-hex data. A
command/reply failure re-reads the fixed cycle through ordinary batches and
isolates failing groups. Unsupported targets disable scatter immediately; three
consecutive failures disable it until reconnection. Acquisition transport errors
retain existing connection handling. Capability detection is optional and bounded;
a lost probe discards the ambiguous FIFO before reconnecting with scatter disabled.

## Manual read-only sampling comparison

On dedicated hardware already running suitable firmware, compare stock and
patched executables with identical variables, interface, clock and serial:

```powershell
$env:EMBERPROBE_HIL_CONFIRM = "YES"
node scripts/measure-sampling-scatter.js --openocd C:/tools/stock/bin/openocd.exe --probe cmsis-dap.cfg --target stm32f4x.cfg --serial YOUR_SERIAL --speed 4000 --elf C:/firmware/app.elf --variables 16 --seconds 10 --output C:/bench/stock.json
node scripts/measure-sampling-scatter.js --openocd C:/tools/scatter/bin/openocd.exe --probe cmsis-dap.cfg --target stm32f4x.cfg --serial YOUR_SERIAL --speed 4000 --elf C:/firmware/app.elf --variables 16 --seconds 10 --output C:/bench/scatter.json
```

Use `--addresses 0x20000000,0x20000100,0x20000200` instead of `--elf` for explicit
aligned 4-byte words. Addresses are restricted to conventional SRAM
`0x20000000..0x3fffffff` or CCM `0x10000000..0x1007ffff`. ELF selection uses
writable allocated sections in these ranges, sampling up to four bytes from
each global and choosing N globals separated by more than the 32-byte merge gap.
Too few globals cause an error. Inspect the recorded item list for your board.
`--variables` applies to ELF selection (default 16); `--seconds` defaults to 10.
`--serial` is optional; `--speed` defaults to 0 (configuration script default).

The script refuses hardware access without `EMBERPROBE_HIL_CONFIRM=YES`, starts
one standalone unlimited-mode session, and records achieved Hz, p50/p95 cycle ms,
actual Tcl RPCs per completed cycle, `scatterReads`, `noEchoResponses`, version,
items and elapsed time. Capability/version queries are excluded from cycle counts;
incomplete cycles fail the run. It uses init/memory reads/shutdown, with no reset,
halt, programming, writes or driver changes. Interface/target configs are trusted
inputs; choose scripts whose init/examine events are read-only too. Do not run
this as a normal software test. Software checks do not establish real-board
support or performance.
