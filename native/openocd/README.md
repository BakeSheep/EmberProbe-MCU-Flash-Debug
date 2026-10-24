# Bundled OpenOCD scatter build

The Windows x64 and Linux x64 VSIX resources contain an EmberProbe build based on
upstream OpenOCD revision `e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3`, the source
used by xPack 0.12.0-7, plus the scatter patch. These are modified builds, not
official xPack binaries. Default `openocd` configuration uses the bundled runtime
on both platforms. Explicit paths, including older manually installed paths,
remain selected until the user resets the setting or reinstalls the bundle.

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

## Locked builds and packaging

Run from Linux x86_64 or WSL with Docker and Node installed. The wrapper runs both
native xPack configurations inside the Debian 10 XBB image pinned by digest in
`build-lock.json`. The lock also records the OpenOCD/xPack revisions, submodules,
toolchain versions and source download hashes. No floating submodule updates are used.

```sh
bash native/openocd/build.sh
npm run openocd:package -- --input test-results/openocd-scatter-release
npm run check:openocd-bundle
npm run package
node scripts/verify-openocd-vsix.js dist/emberprobe.vsix
```

Build caches remain outside the repository. A build identity includes the lock,
patch and build recipes; each platform must identify the same build. The packager
stages both platforms and corresponding sources, verifies them, then publishes the
manifest last with rollback on failure. Updating a patch or recipe requires a new
build, not manually editing hashes. Normal release CI verifies prebuilt resources
and performs native smoke checks on Windows/Linux; it does not compile OpenOCD.

Runtime archives retain scripts, dependency libraries and licenses under
`distro-info/licenses/`. `BUILD-INFO.json` and `distro-info/emberprobe-targets.json`
record build identities and target wrappers. Linux modes and links survive packaging
on Windows because the packager streams the original tar entries.

## Corresponding sources

`native/openocd/emberprobe-openocd-source.tar.gz` is maintained alongside the
runtime archives and uploaded with every VSIX in the same GitHub Release. It contains
the actual OpenOCD source and submodules, dependency source inputs, build recipes,
lock and scatter patch, with a source inventory. The VSIX contains the patch, lock,
recipes, this guide and dependency licenses; the full source archive stays outside
it. The resource manifest pins the source archive hash. Public Release creation occurs
only after both the VSIX and source asset upload succeeds; retries replace both assets.

Historical prototype validation below used Ubuntu 26.04 builds. It does not establish
hardware compatibility or timings for a newly packaged build.

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

## Default selection and fallback

Windows/Linux x64 prepare the bundled runtime offline when `emberprobe.openocdPath`
is left at `openocd`. The installation directory includes the archive hash, so an
extension update does not replace programs used by another window. Installation
failure is reported before hardware startup. macOS and ARM64 still use external tools.
An explicit path is never silently replaced; reset the setting or use the existing
bundled-install action to move from an older manually configured runtime.

Each connection probes `emberprobe_read_scatter version`. Unsupported targets and
external unpatched OpenOCD keep ordinary reads. An unexamined target is checked again
after the first successful cycle. `stats().scatterReads` reports the selected path.

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
