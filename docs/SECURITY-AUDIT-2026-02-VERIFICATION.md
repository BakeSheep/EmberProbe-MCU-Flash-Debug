# 安全审查报告独立复核 / Verification of SECURITY-AUDIT-2026-02

- **被复核对象**：`docs/SECURITY-AUDIT-2026-02.md`
- **复核方式**：逐条回读报告引用的源文件与行号；对可复现条目用 Node 22/24 独立构造输入实测（不依赖报告作者的任何脚本）
- **复核结论**：**17 个条目中 17 条属实**。高危 / 中危 / 低危 / 信息级的定级与「可利用性」判断均与代码实际状态一致，未发现夸大或误报。
- **复核环境**：`C:\Users\ASUS\Desktop\EmberProbe`，Node `22.22.2`

---

## 1. 逐条核对结果

| 条目 | 定级 | 报告核心断言 | 复核结论 |
|---|---|---|---|
| §1 Skill 安装器符号链接越界递归删除 | 高危 | `skillInstaller.js:226-232` 无 `lstat`/`realpath`，`mkdir`+`readdir`+`rm` 穿透链接 | ✅ **属实，已实测复现** |
| §2 DWARF 缩写缓存无界 | 高危 | `parser.js:76,111-115` 以文件可控 u32 为 key、永不淘汰；`MAX_ATTRS_PER_ABBREV=1000` | ✅ 属实（代码逐行一致） |
| §3 DWARF DIE 预算按 CU 重置 | 高危 | `guard` 在 CU 循环内、`dies/childrenMap/variableOffsets` 在循环外全局累积 | ✅ 属实（代码逐行一致） |
| §4 CSP 构建 4 处结构性弱点 | 中低危 | 只替换首个 CSP meta、`</script>` 提前截断、`<stylesheet>` 未提取、内联属性未剥离 | ✅ 属实（4 条全部成立） |
| §5 命令分发原型链查找 | 低危 | `commandHandlers[cmd]` 未用自有属性校验、表非 `Object.create(null)` | ✅ 属实 |
| §6 OpenOCD 归档/二进制无完整性校验 | 低危 | 唯一校验是 `accessSync(R_OK)`；「验证」即执行二进制 | ✅ 属实 |
| §7 `workflow_dispatch.tag` 未校验 | 低危 | `type: string` 无 pattern，用于 `checkout ref`；`publish` 持 `contents: write` | ✅ 属实（缓解措施亦属实） |
| §8 Agent Bridge 指针由工作区控制 | 低危 | 信任工作区 `descriptorPath`，仅校验 `host`/`port` 整数/`token` 真值 | ✅ 属实 |
| §9 CMSIS-Pack 校验和自引用 + 失效开放 | 低危 | 摘要与 pack 同源；缺失/格式不符时整条 `if` 短路 | ✅ 属实 |
| §10 `resolveBound` 未比对内容地址 | 信息级 | 重算 `sha256` 但不与目录名比对，返回目录名 | ✅ 属实 |
| §11 外设写入缺 RAM 段等价约束 | 信息级 | 仅校验 32 位地址空间；`assertWritable` 比预期更强 | ✅ 属实 |
| §12 非独占暂存目录 + 竞态 | 信息级 | 可预测 nonce 命名、`mkdirSync` 非独占、rename 后不复检摘要 | ✅ 属实 |
| §13 Tcl-RPC 端口无认证 | 信息级 | 采样期 `tcl_port` 对任意本机进程开放，仅 `bindto 127.0.0.1` | ✅ 属实（注释明确记录取舍） |
| §14 杂项（6 项） | 信息级 | PowerShell 由 `SystemRoot` 拼接、206 不查 Content-Type、`localResourceRoots` 冗余、`title` 未剥换行、按 PID `kill`、`retainContextWhenHidden` | ✅ 6 项全部属实 |
| §17.1 zstd 按 `ch_size` 预分配 | 中危 | 长度校验在 zstd 路径恒不成立；每节 128 MiB、非跨节共享 | ✅ **属实，已实测复现** |
| §17.2 SVD BigInt 逐字符移位 | 中危 | Θ(L²/64) 且无长度上限，跑在扩展宿主单线程 | ✅ **属实，已实测复现** |
| §17.3 `javaProperties` 二次正则 | 低危 | `/\\+$/` 逐位置失败 ⇒ 每行 O(n²) | ✅ **属实，已实测复现** |
| §17.4 DWARF 递归无深度上限 / `strx` 负值 | 低危 | `types.js:56-87` 无 depth；`parser.js:62-67` 缺 `entryOff < 0` | ✅ 属实 |
| §15 「已确认无问题」16 项 | — | 命令注入、XXE、Zip Slip、SSRF、TOCTOU、RAM 越界等 | ✅ 抽查 12 项，全部与代码一致 |
| §17.6 归档解压复检 | — | node-tar 的 `onentry` 早于自身清理钩子；托管归档 1194 条目全为普通文件/目录 | ✅ 属实（归档清单逐条核对） |

---

## 2. 独立实测复现（未复用报告作者脚本）

### 2.1 §1 符号链接越界删除 —— 复现成功

在系统临时目录构造：受害目录 `VICTIM/`（含 2 个文件 + 1 个子目录），工作区 `<ws>/.agents/skills/_emberprobe` 为指向 `VICTIM` 的 junction，然后逐行执行 `skillInstaller.js:227-232` 的同一循环：

```
[A] victim before: [ 'important1.txt', 'important2.txt', 'subdir' ]
[A] mkdir(recursive) on junction: NO error
[A] readdir(junction) returns: [ 'important1.txt', 'important2.txt', 'subdir' ]
[A] victim AFTER: []                       ← 工作区外目录被清空
[A] victim dir still exists: true | runtimeRoot is symlink: true
[B] rm(link,{recursive}): link gone = true | target survived = true
```

- `mkdir(recursive)` 对「指向目录的链接」静默成功、`readdir` 跟随链接、`rm(<link>/<name>)` 真删目标内容 —— 与报告描述完全一致。
- `[B]` 同时验证了报告 §17.6 的附注：`fs.rm(link, {recursive:true})` 只删除链接本身，因此 `uninstallSkill:275`、`skillInstaller:239` 不受同一根因影响。**报告对影响范围的收窄是准确的，没有扩大化。**

### 2.2 §17.1 fzstd 长度校验形同虚设 —— 复现成功

手工构造 25 字节合法 zstd 帧（magic + FHD + 1 字节 FCS + 一个 16 字节 last raw block），复现 `binary.js:69`：

```
frame length: 25 (报告声称 25)
expectedSize=64            -> returned length=64,          zero-filled tail=true
expectedSize=1024          -> returned length=1024,        zero-filled tail=true
expectedSize=67108864      -> returned length=67108864,    zero-filled tail=true
=> binary.js:73 (data.length !== expectedSize) throws? false
```

源码层面也确认了成因：`fzstd@0.1.1` 的 `decompress(dat, buf)` 在传入 `buf` 时把它 push 进 `bufs` 后由 `cct()` 原样返回（`node_modules/fzstd/lib/index.js:614,628,650,594-596`），因此 `data.length === expectedSize` 恒成立。**报告「<1 KB 的 ELF 可占数百 MiB」的机理成立。**

### 2.3 §17.2 / §17.3 二次复杂度 —— 复现成功

```
[17.2] 50000 digits -> 58 ms | 100000 -> 218 ms | 200000 -> 1407 ms      (报告: 65 / 216 / 1266)
[17.3] 20000 反斜杠 -> 127 ms | 40000 -> 507 ms | 80000 -> 2316 ms        (报告: 127 / 525 / 1997)
```

两条均为干净二次曲线，与报告量级吻合。

### 2.4 §17.6 托管归档本体 —— 逐条核对一致

```
resources/openocd-win32-x64.tar.gz   2,636,626 B（报告 2.6 MB）
条目总数 1194（报告 1194）
-rw-rw-rw- 1131 + -rwxrwxrwx 1 = 1132 普通文件（报告 1132）
drwxrwxrwx 62 目录（报告 62）
含 .. 或绝对路径的条目：0（报告 0）；零符号链接 / 硬链接 / 字符设备
```

### 2.5 §15.16 依赖扫描 —— 一致

```
npm audit --json -> vulnerabilities.total = 0（prod 18 / dev 226 / optional 46）
```

---

## 3. 复核中发现的值得补充的两点（非报告错误）

1. **§4 表格第 1 行的可利用性可以更弱。** 报告描述「注入的第二个 CSP meta 存活」在字面上正确（`webviewAssets.js:109` 无 `g` 标志，只替换首个）。但 CSP 多策略是按**交集**合并的，追加一个宽松 meta 并不能放宽有效策略。因此该行的真实风险比其他三行（`</script>` 截断、`<stylesheet>` 未提取、内联 `on*` 未剥离）更低；报告已把它整体标注为「当前不可利用」，结论不受影响。
2. **§4 值得补一条观察**：`src/modernView.js:17` 的源模板本身就写入了宽松 CSP（`script-src 'unsafe-inline'`），它完全依赖 `webviewAssets.js` 的正则替换才被加固版覆盖。这进一步说明「CSP 靠字符串替换构建」这一结构本身是脆弱点，可作为 §4 修复优先级的额外论据。

---

## 4. 总体判定

报告的质量高于常见的自动化扫描输出：

- 每条都给出了**真实存在的行号**，且引用的代码片段与仓库当前状态逐字一致；
- 对「可利用性」做了克制标注（如 §1 主动指出 `untrustedWorkspaces.supported: false` 的前提、§6 明确划为本地/供应链加固而非远程漏洞、§11 承认 `assertWritable` 比预期更强）；
- §15 的「无问题」清单经抽查全部成立，未出现「把安全代码误报为漏洞」的情况；
- 两个最重的结论（§1、§17.1）经独立实测**完全复现**。

**结论：该报告的 17 个条目全部属实，可以据此排期修复。** 建议按报告 §16 的优先级执行，其中 §1（P0，一行 `lstat` + 包含性校验 + 补测试）与 §17.1（zstd 改为逐块计数）改动最小、收益最高，适合优先落地。

---

*复核：独立读取源文件 + 独立构造输入实测。复核过程未修改任何源文件；临时测试脚本位于系统临时目录。*
