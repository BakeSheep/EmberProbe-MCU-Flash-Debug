# EmberProbe 安全审查报告 / Security Audit Report

- **审查对象**：EmberProbe v0.7.7（`master` @ `8e2b65d`）
- **审查范围**：`src/**`、`skills/**`、`scripts/**`、`.github/workflows/**`
- **审查方法**：人工代码走查（source → sink 完整污点追踪）+ 对关键函数注入恶意输入实测 + 依赖漏洞扫描 + 四个并行专项深审
- **依赖扫描**：`npm audit` → **0 vulnerabilities**（prod 18 / dev 226 个包）

---

## 0. 总体结论

**发现 2 个高危漏洞、3 个中危漏洞**，其余为纵深防御加固项。没有发现远程可达的 RCE、认证绕过或内存不安全（越界读 / 任意读 / 信息披露）——解析器全部是纯 JS 的 `Buffer`/`Uint8Array` 操作，越界访问要么抛 `ERR_OUT_OF_RANGE` 要么返回 `undefined`。**真正的缺陷类别是扩展宿主线程上的资源耗尽（OOM / 卡死）。**

两个高危漏洞**不需要用户点击任何按钮**：§1 在打开文件夹时自动触发，§2/§3 由「工作区中出现任一新 `.elf`」自动触发（`autoDetect` 取 mtime 最新者解析）。

除此之外，这个代码库的安全基线显著高于同类 VS Code 硬件扩展的平均水平。多个在同类项目中几乎必然出现的漏洞类别，在这里被显式、正确地处理了：

| 常见漏洞类别 | 本项目状态 |
|---|---|
| 命令注入 | ✅ 全部 8 处进程创建点均 `shell:false` + argv 数组，无 `exec` 字符串拼接 |
| OpenOCD / Tcl 参数注入 | ✅ `quoteTclWord` 转义 `\ " $ [ ] \r \n`；配置名走 `isSafeCfgPath` 白名单 |
| 工作区遮蔽官方脚本 | ✅ `cwd` 固定为 `scriptsRoot` 且 `realpath` 包含性校验 |
| Zip Slip / tar 路径穿越 | ✅ `assertSafeEntryPath` + `safeZipName` + 显式拒绝符号链接条目 |
| XXE / DTD / 实体扩展 | ✅ 三处 SVD/PDSC 解析器全部拒绝 `<!DOCTYPE`/`<!ENTITY` 且 `processEntities:false` |
| 解压炸弹 / 无界分配 | ✅ `maxOutputLength`、`validateEntrySizes`、按 `ch_size` 预分配缓冲区 |
| 二进制解析越界 | ✅ 全边界检查 + LEB128 移位上限 + DIE/缩写/递归深度预算 |
| 代理桥鉴权 | ✅ 24 字节随机 token + `timingSafeEqual` + Host 头校验（防 DNS rebinding） |
| 烧录 TOCTOU | ✅ 授权时 hash → 执行前重新 hash → 写入 0600 临时快照供 OpenOCD 消费 |
| 原型污染 | ✅ 全仓库仅一处 `Object.create(null)`，与消息处理无关 |
| CSV 公式注入 | ✅ 对 `= + - @ \t \r` 前缀加 `'` |
| Webview CSP | ✅ `default-src 'none'` + 144 位 nonce，`localResourceRoots` 未放开到工作区 |
| CI PR 提权 | ✅ `pull_request` 仅 `contents: read`，自托管 runner 不对 PR 开放 |

因此下列条目绝大多数是**纵深防御加固建议**。每条都标注了真实可利用性，不做夸大。

---

---

## 1. 高危：Skill 安装器经由工作区符号链接越界递归删除任意目录

**文件**：`src/skillInstaller.js:226-232`（`installSkill`）

```js
226        const runtimeRoot = path.join(targetRoot, "_emberprobe");   // <ws>/.agents/skills/_emberprobe
227        await fs.mkdir(runtimeRoot, { recursive: true });           // runtimeRoot 为指向目录的链接时静默成功
229        for (const name of await fs.readdir(runtimeRoot)) {         // readdir 跟随链接
230            if (name !== "agent-bridge.json")
231                await fs.rm(path.join(runtimeRoot, name), { recursive: true, force: true });
232        }
```

**完整污点路径**：

```
工作区文件 .agents/skills/_emberprobe   ← 攻击者提交的符号链接 / junction
  → workspaceSkillsRoot()               skillInstaller.js:78-81
  → targetRoot = <ws>/.agents/skills
  → runtimeRoot = targetRoot/_emberprobe
  → fs.mkdir(runtimeRoot, {recursive:true})   穿透链接，静默成功
  → fs.readdir(runtimeRoot)                   跟随链接，返回「真实目标目录」的条目
  → fs.rm(..., {recursive:true, force:true})  逐个真删
```

整条路径上**没有 `lstat`、没有 `realpath`、没有任何包含性校验**。这是本仓库中唯一未做符号链接防护的工作区路径 sink——其余六处（`configurationStore.workspacePath`、`cubemxCandidate.generateCandidate:169-179`、`cubemxEnvironment.workspaceIoc:124-135`、`cubemxService.plan:150-155`、`openocdScripts.resolveConfigFile:70-90`、`cubemxProject.snapshot:49-54` / `applyFiles:287-306,315-319`）全部做了 `realpath` + `path.relative` 包含性校验。

**触发无需任何用户操作**：

```
extension.js:79   provider.refreshSkillStatus(true)        ← 激活时（onStartupFinished / workspaceContains / onView）
extension.js:39   工作区文件夹变更时
  → skillStatusService.refresh(true)                       skillStatusService.js:25-34
  → updateEnabledSkills()                                  skillStatusService.js:42-50
  → if (["outdated","modified","partial"].includes(state))
        installSkill(vscode, context, lang, "workspace")   ← :49，无任何确认对话框
```

攻击者只需在仓库中提交真实的 skill 文件（这些文件是公开的）但**省略或填错 `.emberprobe-skill.json`**，即得到 `outdated`；或只提交其中一个 skill 目录，即得到 `partial`。两者都会命中自动更新分支。

**实测验证**（Node 24，临时目录，Windows junction；Linux/macOS 上 git 会把 `_emberprobe` 实体化为真实符号链接，POSIX 语义相同）：

| 步骤 | 观察结果 |
|---|---|
| `fs.mkdirSync(link, {recursive:true})` | 不报错 |
| `fs.readdirSync(link)` | 返回**目标目录**的条目 |
| 执行上述完全相同的循环 | **受害目录被清空** |
| 后续 `fs.cp(stage/_emberprobe, runtimeRoot)` | 抛 `ERR_FS_CP_DIR_TO_NON_DIR` → 安装在**删除之后**才中止 |

**影响**：对工作区之外、由攻击者指定的任意目录执行 `rm -rf`（仅保留名为 `agent-bridge.json` 的条目）。

**同一根因、较小影响**：若 `targetRoot`（`.agents/skills`）本身是链接，则 `:239-243` 与 `uninstallSkill:261-263` 会删除 `<target>/` 下的 9 个 skill 名 + 4 个 legacy 名，并向目标目录写入约 50 个文件。

**严重性判定**：标为**高危**——触发完全自动化、破坏落在工作区之外、且为用户主目录级不可逆数据丢失。**需注意的前提**：`package.json` 声明 `untrustedWorkspaces.supported: false`，因此需要用户信任该工作区。若团队的威胁模型把「已信任工作区的内容」整体排除在外，可降级为中危；但考虑到「打开文件夹」在 VS Code 中是常规操作、且没有任何确认步骤，本报告按高危处理。

**修复**：

```js
const st = await fs.lstat(runtimeRoot).catch(() => null);
if (st?.isSymbolicLink() || (st && !st.isDirectory())) {
    await fs.rm(runtimeRoot, { force: true });        // 只 unlink 链接本身，绝不进入其目标
} else if (st) {
    // 通过包含性校验后再遍历
    const realRoot = await fs.realpath(targetRoot);
    if (!inside(realRoot, await fs.realpath(runtimeRoot))) throw ...;
    for (const name of await fs.readdir(runtimeRoot)) { ... }
}
```

同样的 `realpath` 包含性校验应加到 `:225`、`:239` 以及 `uninstallSkill:259-263`。另外建议新增测试：`test/skill-installer.test.js` 目前**完全没有** `symlink` / `lstat` / `realpath` 相关断言。

---

## 2. 高危：DWARF 缩写表按文件可控偏移重复解析且无上限 → 扩展宿主 OOM 崩溃

**文件**：`src/dwarf/parser.js:76, 111-115`；`src/dwarf/binary.js:5, 118-147`

```js
const abbrevCache = new Map();                     // parser.js:76
...
let abbrev = abbrevCache.get(abbrevOff);           // :111  key 是 .debug_info 里的原始 u32
if (!abbrev) {
    abbrev = parseAbbrev(abbrevSec.data, abbrevOff);   // 解析到节尾，最多 10 万个缩写
    abbrevCache.set(abbrevOff, abbrev);                // :114  永不淘汰、永不设总量上限
}
```

```js
const MAX_ATTRS_PER_ABBREV = 1000;                 // binary.js:5
while (true) { const at = readULEB(buf,cur); const form = readULEB(buf,cur);
               ...; attrs.push({at, form, implicit}); }
```

**问题**：`abbrevOff` 是文件里任意 u32，而缓存以它为键，因此 **N 个不同偏移 ⇒ 同时存活 N 份完整缩写表**。每个缩写最多带 1000 个属性，而每个属性只占 2 字节输入 ⇒ 约 2003 字节输入产出 1000 个堆对象。`parseAbbrev` 只在遇到 code 0、10 万缩写、或 128 MiB 节上限时停止——都远超堆能承受的量。

**实测**（`--expose-gc`，构造不同的缩写 code）：**每个 `.debug_abbrev` 输入字节约放大 29.5 字节堆**（10,029,873 B → 281.9 MiB；2,005,873 B → 59.4 MiB）。端到端经 `parseDwarf`：**10,030,212 字节的构造 ELF → `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`，退出码 134，约 3 秒**（堆上限 1 GiB）。仅用模块自身的 128 MiB 节上限计算，单次解析就需约 3.6 GB；2 MiB 缩写表 + 33 字节 `.debug_info`（3 个各 11 字节的小 CU）即可在 96 MiB 堆上限下崩溃。

**影响**：扩展宿主进程硬崩溃（窗口重载、实时采样与调试状态全部丢失），且每次重新读取 ELF 都可重复触发。CWE-770 / CWE-789。

**修复**：(a) 把 `abbrevCache` 改为有界 LRU（如 8 条）；(b) 缩写与属性的预算改为**全局**而非每次调用独立（如总计 ≤2 万缩写、≤20 万属性）；(c) 把 `MAX_ATTRS_PER_ABBREV` 降到几百（真实编译器远达不到 1000）。

---

## 3. 高危：DWARF DIE 预算按 CU 重置而映射全局累积 → 扩展宿主 OOM 崩溃

**文件**：`src/dwarf/parser.js:71-73, 120-125, 216-217`

```js
const dies = new Map();          // :71  CU 循环之外，全程累积
const childrenMap = new Map();   // :72
const variableOffsets = [];      // :73
...
while (cur.p < cuEnd) {
    if (guard++ >= MAX_DIES_PER_UNIT) throw ...     // :124  guard 定义在 CU 循环之内
    dies.set(dieOff, rec);                          // :216
}
```

`guard` 定义在 CU 循环体内（`MAX_DIES_PER_UNIT = 2000000`，`:122`），**每个编译单元都会重置**，而 `dies` / `childrenMap` / `variableOffsets` 从不重置。因此该预算只约束单个 CU，不约束整个文件。一个 DIE 最少只需 **1 字节**（零属性的缩写 code），放大比约 100:1，且可跨 CU 重复。

**实测**：3,000,268 字节 ELF（单 CU 全 1 字节 DIE）→ 保留 200 万 DIE，**298 MiB 堆**；4,200,276 字节 ELF（2 个 CU × 2.1 MB）→ 在 200 MiB 堆上限下 **OOM 崩溃（退出码 134）**。按允许的 128 MiB `.debug_info` 外推可达数十 GB。

**可达性（无需信任工作区）**：

```
工作区中出现任一新 .elf
  → autoDetect.newestElf()          autoDetect.js:9  findFiles("**/*.elf") 取 mtime 最新
  → runAutoDetect()                 mainViewProvider.js:3032-3039 写入 elfPath
  → _refreshElfBindings() → readElfSymbols() → ElfService.read()
  → fs.readFileSync(elfPath)        elfService.js:39   ⚠ 无任何体积上限
  → parseDwarf(buffer)              elfService.js:58
```

`elfService.js:32` 已 `statSync` 拿到 `size`，但**只用于缓存比对，从不做上限校验**。侧边栏初始化检查（`mainViewProvider.js:3012`）在工作区未配置时会自动调用 `runAutoDetect`；此外任意一次 `variables.read` / `watch.add` 也会触发 `readElfSymbols()`。

**修复**：DIE / 偏移预算改为**整个解析全局**（不是每 CU）；不要保留所有 DIE——`types.js` 只消费 `DW_TAG_variable` 与 `structure_type`/`union_type`/`array_type`/`subrange_type` 及其父节点；同时限制 `variableOffsets` 与 `childrenMap`；并在解析前加 ELF 体积硬上限（`statSync().size`，对 MCU 固件 64 MiB 已极宽裕）。

---

## 4. 中低危：CSP 构建逻辑存在多处结构性弱点

**文件**：`src/webviewAssets.js:69-112`

**问题**：`externalizeWebviewHtml` 用正则处理 HTML，对真实函数注入恶意 HTML 实测确认 4 个缺陷：

| 输入 | 实测结果 |
|---|---|
| 两个 CSP `<meta>` | **只替换第一个**，注入的 `default-src *; script-src 'unsafe-inline'` 存活 |
| `<script>var s="</script>";var b=2;</script>` | 正则提前截断，`b=2` 泄漏到 nonce 脚本标签之外 |
| `<stylesheet>RAW</stylesheet>` | **完全未被提取**，原样进入最终 HTML |
| `onclick="…"` / `style="…"` | **未被剥离**，原样保留 |

**当前不可利用（已实测）**：唯二 HTML 生产者 `src/modernView.js` 与 `src/liveWatchView.js` 都是静态模板，插值仅来自冻结的 i18n 常量表（`src/i18n/index.js:8`）、`esc()` 转义的配置串、`jsonForScript()` 序列化的数字。向每个宿主侧插槽注入 `<img src=x onerror=alert(1)>` 与 `"><script>alert(2)</script>` 均被正确转义；生成的 HTML 中零内联事件处理器。

**风险**：一旦未来任一模板开始插值非受信数据，上述任一条立刻变成可用的 CSP 绕过。

**修复**：
```js
// 1. 全量替换（加 g 标志），或断言替换后不再存在 CSP meta
html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, meta);
// 2. 脚本已全部外部化，nonce 已无必要，去掉可消除整类绕过面
`script-src ${webview.cspSource}`;
// 3. 提取后断言内容不含 "</script"；剥离或断言不存在内联 on* / style 属性
```

---

## 5. 低危：宿主命令分发使用原型链查找

**文件**：`src/mainViewProvider.js:78, 2827-2828`

```js
this.commandHandlers = {};                       // :78
...
const cmd = message.cmd;                         // 未校验的 webview 字符串
if (this.commandHandlers[cmd]) {                 // 原型链查找，非自有属性
    const result = await this.commandHandlers[cmd]();
```

**问题**：用真实生产对象验证，`commandHandlers["constructor"]`、`["hasOwnProperty"]`、`["toString"]`、`["valueOf"]` 都是原型链上的真实函数，均能通过 `if` 判断并被调用；`["__proto__"]` 为真值对象，调用时抛 `TypeError`，被 catch 后以空 `error` 字符串回给 webview。

**当前不可利用**：没有注册处理器能通过原型键命中，所有可达原型函数在 `this = commandHandlers` 下均无副作用。

**修复**：
```js
if (Object.prototype.hasOwnProperty.call(this.commandHandlers, cmd)) { ... }
// 并把表构造改为 this.commandHandlers = Object.create(null);
```

---

## 6. 低危：内置 OpenOCD 归档与已安装二进制从未做完整性校验

**文件**：`src/openocdInstaller.js:19-30, 112-142, 161-184, 204-210`；`src/openocdChecker.js:50-55, 283-294`

```js
// openocdInstaller.js:24-29 —— 唯一校验是「文件可读」
fs.accessSync(abs, fs.constants.R_OK);
// openocdChecker.js:283-294 —— 所谓"验证"就是执行该二进制
stagedProbe = await probeOpenOcd(candidate);
```

**问题**：
- `resources/openocd-win32-x64.tar.gz`（2.6 MB，已提交入库，SHA-256 `df9384d3…d1be9b`）在仓库中**没有任何地方记录其摘要**，也没有解析前的校验。
- 解压出的 `openocd.exe` 落在 `globalStorageUri/emberprobe/openocd/bin/` —— 一个**用户可写目录**，随后在每次烧录 / 调试 / 实时采样时被 spawn（`openocdRunner.js:336`、`liveWatch.js:275`、`openocdExec.js:56`）。
- "验证"仅确认该文件打印 OpenOCD 版本横幅，任何替换品都能做到。

**可利用性**：**低**。这不是远程可达链路（扩展从不下载 OpenOCD），跨越的是同用户边界——攻击者需已能以该用户身份写文件。属于供应链 / 本地加固缺口，而非远程漏洞。但它使篡改**完全不可检测**。

**修复**：在 `BUNDLED_DIR` 旁固定归档摘要并在 `tar.x` 前校验；安装后记录二进制摘要，每次 spawn 前复检（Windows 上可校验 Authenticode）；CI 发布流程中校验同一摘要。

---

## 7. 低危：`workflow_dispatch` 的 `tag` 输入未校验即用于 `checkout`

**文件**：`.github/workflows/release.yml:7-12, 39, 82`

```yaml
workflow_dispatch:
  inputs:
    tag:
      type: string          # 自由字符串，无 pattern 约束
...
- uses: actions/checkout@v5
  with:
    ref: ${{ inputs.tag || github.ref }}
```

**问题**：任何具备 write 权限（或更细粒度 Actions 触发权限）的协作者，都能以任意 git ref 运行发布流水线；`publish` 作业持有 `contents: write` 与 `GH_TOKEN`。

**已有缓解**：`build` 阶段执行 `scripts/validate-release.js`，强制 tag 形如 `vX.Y.Z` 且与 `package.json`/lock/README/CHANGELOG 完全一致（`scripts/publish-release.js:7` 另有一道同样正则）。因此**无法直接发布任意提交**。实际影响是「可以从未合并的分支发起一次看似合法的发布」，而非任意代码发布。

**修复**：
```yaml
tag:
  type: string
  required: true
# 首个步骤校验：git tag --list "$TAG" 必须命中，且 git merge-base --is-ancestor HEAD origin/master
```

---

## 8. 低危：Agent Bridge 描述文件指针由工作区控制

**文件**：`skills/_emberprobe/agent-client.js:6-39, 499-511`

`descriptor()` 从工作区 `.agents/skills/_emberprobe/agent-bridge.json` 读取 `descriptorPath`，随后无条件读取并信任该路径指向的 JSON（仅校验 `host === "127.0.0.1"`，未校验 `port` 范围、未校验 `token` 长度），再携带 `Authorization: Bearer <token>` POST 过去。

恶意仓库可让该指针指向工作区内的描述文件，把本地端口改为任意监听者，从而**泄露 skill 调用参数（内存值、ELF 路径）并伪造响应回灌给 agent**。真实 token 位于 `globalStorage`（0600）且不会被披露，因此影响限于 localhost 级别的信息披露与响应伪造。

**架构层面已有正确选择**：`agentBridge.js:52-57` 把含 token 的真实描述文件放在用户级 `globalStorage`，工作区只留不含 token 的指针——方向正确。桥本体很扎实：绑定 `127.0.0.1`（`:78`）、Host 头校验（`:127-132`）、`timingSafeEqual`（`:137-142`）、64 KiB body 上限（`:143-152`）。

**修复**：要求客户端按「工作区路径 hash」推导描述文件位置，而不是读取工作区内可被改写的指针；至少校验其位于预期 `globalStorage` 前缀下。并收紧客户端校验（`port >= 1024 && <= 65535`、token 长度正则）。README 中应显著说明 `.agents/skills/**` 属于可执行代码。

---

## 9. 低危：CMSIS-Pack 校验和为自引用且缺失时失效开放

**文件**：`src/services/officialSvdService.js:277-287, 559-562, 574-581`

```js
// :282 —— 期望摘要来自提供 URL 的同一份远程文档
checksum: String(release?.["@_sha256"] || release?.["@_checksum"] || "")
// :574-581 —— 校验和缺失或格式不符时整个 if 短路，等于完全不校验
if (candidate.checksum && /^[a-f0-9]{64}$/i.test(candidate.checksum) && ...) throw ...
```

**问题**：两种失效模式——(a) 摘要与 pack URL 同源，谁提供 pack 谁提供"期望值"，校验恒真，只能防传输损坏而不能防源被攻陷；(b) **属性缺失时完全跳过校验**，而这是常态：仓库自带的 fixture `<release version="1.2.3"/>`（`test/svd-services.test.js:229`）就没有该属性，**且没有任何测试覆盖该校验分支**。

**可利用性**：**低**。需先攻陷厂商的 HTTPS 主机或 Keil 索引（均为 HTTPS 且 `ensureSafeUrl` 逐跳校验、上限 4 跳）。但"缺失即放行"是错误的默认方向。

**修复**：缺失/格式非法时 fail closed；为受信厂商白名单固定摘要；在进度 UI 中展示实际解析出的主机与 pack URL。

---

## 10. 信息级：SVD 完整性不变式未被强制（内容寻址未复检）

**文件**：`src/services/svdLibraryService.js:220-241`

`resolveBound` 重算了 `sha256`，但**从不与目录名（内容地址）比对**，且返回的 `hash` 取自绑定表而非重算值：

```js
const hash = this.bindings()[key];              // 目录名
const buffer = await fs.promises.readFile(file);
const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");  // 算了但没比
return { hash, ... };                           // 返回目录名，不是重算值
```

**影响**：`globalStorage/svd-library/<hash>/device.svd` 被本地篡改或损坏时不会被发现，只做结构校验。内容寻址设计本应提供该完整性保证。**风险低**，因为写授权的指纹取自实时 buffer（`svdPeripheralService.js:350-352, 530`），确认后被掉包会使授权失效。

**修复**：`if (sha256 !== hash) throw ...`。

---

## 11. 信息级：外设寄存器写入缺少 RAM 段的等价约束

**文件**：`src/services/svdPeripheralService.js:212-242, 435-447, 723-761`

变量写入路径被严格限制在可写 RAM 段内（`mainViewProvider.js:1506-1507, 1564`），但外设写入路径只校验「32 位地址空间内」，地址完全由 SVD 声明决定。

**已有约束比预期强**（已核实）：`assertWritable`（`:435-447`）会拒绝只写寄存器、拒绝任何带 `readAction` 副作用的寄存器、拒绝带 `modifiedWriteValues` 特殊写语义的寄存器，且要求寄存器**全部字段**均为普通 read-write。这意味着 RDP / option byte / flash 解锁序列等敏感寄存器基本都写不进去（它们通常是只写或带特殊语义）。

**残留面**：SVD 中被声明为普通 read-write 的寄存器仍可指向任意地址；叠加 §6 的 SVD 信任链问题，构造的 SVD 可让界面显示 `GPIOA.MODER` 而实际写到别处。一次性确认对话框会展示目标/寄存器/地址/数值（`peripheralWriteAuthorization.js:58-99`）。

**修复**：考虑增加「外设地址区间」断言（如要求落在 SVD 声明的 `peripheral.baseAddress` 所属区间内并记录来源 SVD 摘要），并在确认 UI 中同时显示 SVD 文件名与摘要。

---

## 12. 信息级：非独占的暂存目录与解析后执行竞态

**文件**：`src/openocdInstaller.js:106-109, 161-184`；`src/openocdScripts.js:16-53`

```js
const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const staging = path.join(parent, `.openocd-staging-${nonce}`);
fs.mkdirSync(staging, { recursive: true });     // 非独占，名称可预测
```

暂存二进制被"验证"（实际是执行）后经 `fs.renameSync(staging, dest)` 交付，之后不再重新计算摘要。`resolveExecutablePath` 用 `realpathSync` / `PATH`+`PATHEXT` 解析，而 spawn 发生在之后，构成 realpath→exec 竞态与环境依赖的目标。

**修复**：不可预测的 0700 暂存目录（`fs.mkdtemp`）；rename 后与 spawn 前重新计算摘要；拒绝 group/world 可写的可执行文件。

---

## 13. 信息级：OpenOCD Tcl-RPC 端口无认证（已知设计取舍）

**文件**：`src/liveWatch.js:18-31, 260-272`

采样期间 OpenOCD 的 Tcl 端口对任意本机进程开放，可下发 `halt` / `write_memory` 等命令，进而改写目标 MCU 的 RAM 与 Flash。

代码做了两层缓解且注释明确记录了取舍：`bindto 127.0.0.1`（`:260`），未显式配置端口时用 `findFreePort()` 随机选取（`:262`）。一次性任务路径已正确使用 `tcl_port disabled`（`openocdExec.js:41-46`、`openocdRunner.js:311-317`），仅采样会话暴露该端口。

**残留风险**：随机端口只提高门槛，不构成认证。**建议**：若 OpenOCD 构建支持，改用 Unix domain socket / 命名管道承载 Tcl-RPC；否则在文档与 UI 中把「采样期间本机任意进程可控制目标芯片」作为显式已知限制提示。

---

## 14. 信息级：杂项

| 项 | 位置 | 说明 |
|---|---|---|
| 环境变量派生 PowerShell 执行 | `cortexDebugPreflight.js:40-64`、`autoDetect.js:73-99` | `powershell.exe` 由 `process.env.SystemRoot` 拼接或经 PATH 解析。需先污染 VS Code 进程环境，风险很低 |
| `requestBuffer` 接受 HTTP 206 且不检查 Content-Type | `officialSvdService.js:104` | 部分响应会被当作完整文档；后续有 XML 校验兜底，仅健壮性问题 |
| 侧边栏 `localResourceRoots` 含多余的 `extensionUri` | `mainViewProvider.js:2817` | 实际只服务 `_webviewAssetRootUri`，可移除 |
| `svdStatusEl.title` 未剥除换行 | `webview/sidebar/renderer.js:1134` | `.title` 是 DOM 属性非 HTML sink，但状态会回传宿主，`\r\n` 可污染诊断文本 |
| 采样 worker 按 PID `process.kill` | `samplingSession.js:55-59` | 未校验 PID 归属，理论上存在 PID 复用误杀；风险极低 |
| `retainContextWhenHidden: true` | `mainViewProvider.js:1885` | 仅实时面板，其资源根最窄，无额外暴露 |

---

## 15. 已核查并确认「无问题」的高危假设（附证据）

本轮重点怀疑、最终被证据排除的项，列出以便复现与回归：

1. **命令注入** — 无。`spawn(..., { shell: false })` 出现在全部 8 处进程创建点（`liveWatch.js:275`、`openocdRunner.js:336`、`openocdChecker.js:55,142`、`openocdExec.js:56`、`cubemxRunner.js:33`、`cubemxFirmware.js:110`、`cortexDebugPreflight.js:50`）；无 `exec` 字符串拼接。ELF 路径经 `quoteTclWord` 转义后包双引号进入 Tcl（`openocdRunner.js:11-21`，回归测试 `test/openocd-parser.test.js:57-60`）。
2. **OpenOCD 配置越界** — 无。`resolveConfigFile` 先 `realpathSync` 再 `path.relative(base, resolved)` 包含性校验（`openocdScripts.js:70-90`），符号链接逃逸被挡住。
3. **`localResourceRoots` 放开到工作区根** — 无。实时面板 `[this._webviewAssetRootUri]`（`mainViewProvider.js:1886`）；侧边栏 `[extensionUri, _webviewAssetRootUri]`（`:2817`）。均不含工作区根。「宽 root + XSS ⇒ 任意读工作区文件」链条无法起步。`enableCommandUris` 全仓库零引用（默认 `false`）。
4. **DOM XSS** — 无。5 处 `innerHTML` 中 4 处是硬编码 SVG 常量；唯一动态 sink `chipBody.innerHTML = EmberProbeChipView.render(...)`（`webview/sidebar/renderer.js:1154`）对每个插值调用 `chipEsc`（`chipView.js:6-11`）。`src/webview/**` 内无 `eval` / `new Function` / `document.write` / `fetch` / `XHR` / `atob`。所有 `setTimeout` 均传函数。
5. **ELF / DWARF 解析越界与炸弹** — 无。`readSectionEntries` 校验 `shoff + shnum * shentsize > buf.length`（`elfFormat.js:30`）；`debugSectionData` 用 `entry.size > buf.length - entry.offset` 规避整数溢出（`dwarf/binary.js:55`）；`readULEB`/`readSLEB` 有 `shift >= 56` 上限（`:19,31`）；解压有 `maxOutputLength` 与按 `ch_size` 预分配缓冲区（`:63-69`）。预算：DIE 200 万/单元、缩写 10 万、每缩写 1000 属性、递归深度 16。
6. **SVD / PDSC XXE** — 无。三处解析入口全部先正则拒绝 `<!DOCTYPE|<!ENTITY` 再 `XMLValidator.validate`，并以 `processEntities: false` 解析（`officialSvdService.js:41-51`、`svdLibraryService.js:43-57`、`svdPeripheralService.js:287-301`）。
7. **CMSIS-Pack 解压** — 无。`safeZipName` 拒绝绝对路径、盘符、`..`、空段（`officialSvdService.js:361-373`）；显式拒绝符号链接条目（`:406-414`）；拒绝重复条目；`yauzl` 以 `validateEntrySizes: true` 打开；pack 限额 512 MiB、SVD 条目 16 MiB。
8. **SSRF / 明文下载 / 凭据泄漏** — 无。`ensureSafeUrl` 强制 HTTPS、拒绝带 userinfo URL、逐跳复检、上限 4 跳（`officialSvdService.js:53-64, 90-103`）；`allowHttpLocalhost` 仅测试调用。全仓库无 `rejectUnauthorized:false`、无 `NODE_TLS_REJECT_UNAUTHORIZED`、无 proxy 环境变量信任、代码中无 `GITHUB_TOKEN`/`GH_TOKEN`。
9. **由芯片标识符注入 URL** — 无。`normalizePart` 仅保留 `[A-Z0-9X*?]`（`deviceIdentityService.js:21-25`），identity 只参与打分与匹配，不参与 URL 构造。
10. **固件烧录授权与 TOCTOU** — 完整。`AgentFlashService.execute` 授权后重算 sha256 比对（`agentFlashService.js:29-33`），随后把已授权字节写入 `mkdtemp` 的 0600 临时快照并让 OpenOCD 消费该快照（`:51-54`），从根上消除 TOCTOU。确认令牌一次性消费、5 分钟 TTL、指纹绑定 ELF/target/probe/openocd。
11. **RAM 变量写入越界** — 无。`_agentWritePlan` 要求变量名解析到 ELF 符号表、DWARF 类型已知（拒绝猜测编码）、地址落在 `SHF_WRITE|SHF_ALLOC` 段内（`mainViewProvider.js:1506-1507, 1545, 1564`）。webview 提交的 `address`/`size` 被 `normalizeWatchList` 丢弃并重新推导（`validation.js:42-84`）。
12. **CubeMX 项目写入穿越** — 无。`snapshot()` 对每条目 `realpath` 包含性校验、拒绝符号链接（`cubemxProject.js:53-54`）；`applyFiles` 写入前再校验父目录、写临时文件后 `rename`、用 `lstat` 防符号链接（`:291, 302, 316`）。
13. **CubeMX `.ioc` 供应链命令执行** — 无。`parseIoc` 显式拒绝自定义生成钩子 / 脚本 / 模板 / 固件路径，以及任何含 `..`、盘符、绝对路径的 `*Path|*Location|*Folder|*FileName` 键（`cubemxProject.js:24-37`）——这正是 CubeMX 项目最危险的命令执行面。
14. **Agent Bridge 提权改配置** — 无。`mainViewProvider.js:698-701` 在 `ConfigurationStore.update` 前调用 `assertAgentSettable`，`configurationStore.js:24-37` 对 `openocdPath`/`cubemxPath` 抛 `CONFIG_KEY_FORBIDDEN`，阻断「token → 本地任意可执行文件」链。
15. **CI 自托管 runner** — 安全。`hil.yml` 仅由 `workflow_dispatch` 与 `schedule` 触发，**不对 `pull_request` 开放**，未审查的 PR 代码不会在自托管 runner 上执行。
16. **依赖漏洞** — `npm audit` 报告 0 个漏洞（含 dev 依赖）。

---

## 16. 修复优先级建议

| 优先级 | 条目 | 工作量 |
|---|---|---|
| **P0** | **§1 Skill 安装器的符号链接越界递归删除**（`lstat` 拒绝链接 + `realpath` 包含性校验 + 补测试） | 小 |
| **P0** | **§2 DWARF 缩写缓存加界**（有界 LRU + 全局缩写/属性预算 + 降低 `MAX_ATTRS_PER_ABBREV`） | 小 |
| **P0** | **§3 DIE 预算改为全局**（不再按 CU 重置；只保留 `types.js` 实际消费的 DIE；加 ELF 体积上限） | 中 |
| P1 | §4 CSP 构建加固（全量替换 meta、去掉 nonce 依赖、剥离内联属性） | 小 |
| P1 | §5 分发改用自有属性校验 + `Object.create(null)` | 极小 |
| P1 | §17.1 zstd 节改为按解码字节计数，`MAX_DWARF_SECTION_BYTES` 降为跨节共享预算 | 小 |
| P1 | §17.2 SVD 数值长度上限（`raw.length > 40` 即拒） | 极小 |
| P2 | §6 为内置 OpenOCD 归档固定摘要并在解压前校验 | 小 |
| P2 | §9 SVD 校验和缺失时 fail closed | 小 |
| P2 | §7 发布工作流限制 `tag` 为已存在的稳定 tag | 小 |
| P2 | §17.3 `javaProperties` 续行判断改用循环；`cubemxService.permission()` 补体积上限 | 极小 |
| P3 | §8 Agent Bridge 客户端不再信任工作区指针路径 | 中 |
| P3 | §10 `resolveBound` 比对内容地址 | 极小 |
| P3 | §13 在文档/UI 显式声明 Tcl 端口为已知限制 | 极小 |
| P3 | §12 不可预测暂存目录 + spawn 前复检摘要 | 小 |
| P3 | §17.4 DWARF 类型解析加深度上限；`resolveStrx` 补负值检查 | 极小 |
| P3 | §14 侧边栏 `localResourceRoots` 去除多余 `extensionUri`；`svdStatusEl.title` 剥除换行 | 极小 |

---

## 17. 补充：归档解压与解析器的独立复检结论

### 17.1 中危：zstd 压缩节按 `ch_size` 预分配，且长度校验形同虚设

**文件**：`src/dwarf/binary.js:59-73`

```js
const expectedSize = data.readUInt32LE(4);
if (expectedSize > MAX_DWARF_SECTION_BYTES) throw ...            // 128 MiB，但只是「每节」
data = Buffer.from(decompressZstd(data.subarray(12), new Uint8Array(expectedSize)));
if (data.length !== expectedSize) throw ...                     // 对 zstd 路径恒不成立
```

`new Uint8Array(expectedSize)` 在任何解析之前就求值，而 fzstd 直接**返回调用方传入的缓冲区**（长度必然等于 `expectedSize`，无论实际解出多少字节），因此该长度校验在 zstd 路径上永远不会触发，全零缓冲区会被当作合法节数据接受。

**实测**：一个 **25 字节的合法 zstd 帧**（magic + FHD + 1 字节 FCS + 一个 16 字节 last raw block）传入 `decompress(..., new Uint8Array(64*1024*1024))`，返回 64 MiB 缓冲区，第 16 字节之后全为零，且不抛错。5 个必需节 × 128 MiB = **一个 <1 KB 的 ELF 即可占用 640 MiB（`Buffer.from` 拷贝后峰值约 900 MiB）**。zlib 路径会校验真实长度，但上限仍是「每节」而非「合计」，而且 128 MiB 全零数据 deflate 后仅约 130 KB（实测压缩比 1028:1），所以约 650 KB 的 ELF 同样能产生 640 MiB。

**修复**：把 `MAX_DWARF_SECTION_BYTES` 降到 16–32 MiB（对 MCU 固件已极宽裕）并改为**跨节共享预算**；zstd 路径改用 `new (require("fzstd").Decompress)(cb)` 逐块计数（超过上限即中止），或要求帧声明的 content size 等于 `ch_size` 后再分配；绝不可把 `ch_size` 直接当作输出长度。

### 17.2 中危：SVD `enumeratedValue` 用 BigInt 逐字符移位解析 → 扩展宿主长时间卡死

**文件**：`src/services/svdPeripheralService.js:164-182`

```js
const binary = raw.match(/^(?:#|0b)([01x]+)$/i);
for (const digit of binary[1].toLowerCase()) {
    value <<= 1n; mask <<= 1n;
    if (digit !== "x") { mask |= 1n; if (digit === "1") value |= 1n; }
}
```

每次迭代都左移一个**逐位增长**的 BigInt，复杂度为 Θ(L²/64)，且**没有长度上限**（`integer()` 在 `bigint:true` 时跳过 `MAX_SAFE_INTEGER` 检查）。

**实测**（经真实入口 `parseSvd()`）：5 万位 → 65 ms，10 万位 → 216 ms，20 万位 → 1266 ms，**40 万位 → 6794 ms**（干净的二次曲线）。4 MB 的 `<value>#1010…</value>` 约需 11 分钟；30 MB（文件上限 32 MB）需数天，且全部发生在**单条扩展宿主 JS 线程**上（VS Code 无响应，且不可取消）。可达路径：对任何工作区 SVD（`svdManager.js:124` 扫描 `**/*.svd`）或 CMSIS-Pack 下载的 SVD 执行外设 list/read/write → `SvdPeripheralService.model()`（`:531`）→ `parseSvd()`（`:282`）。

**修复**：在做大整数转换前拒绝过长的数值（SVD 数值 ≤64 位，例如 `raw.length > 40` 即抛 `INVALID_SVD_VALUE`）；或以硬性位上限（如 256 位）增量解析占位符 / 十六进制，而不是逐字符 `<<= 1n`。`integer()` 的十进制分支（`:33`）应加同样的守卫。

### 17.3 低危：`javaProperties.js` 续行判断使用二次复杂度正则

**文件**：`src/services/javaProperties.js:29`

```js
while ((logical.match(/\\+$/)?.[0].length || 0) % 2 === 1) {
```

`/\\+$/` 在一段很长的内部反斜杠串中的**每一个位置**都会失败，每次尝试代价为 O(串长) ⇒ 每行 O(n²)。

**实测**：`A=` + n 个反斜杠 + `x` + `\\`：2 万 → 127 ms，4 万 → 525 ms，8 万 → 1997 ms，**16 万 → 11,871 ms**。`cubemxProject.parseIoc` 的 1 MiB 上限仍允许约 100 万个反斜杠（约 8 分钟阻塞事件循环）；`cubemxService.js:264` 读取工作区 `.ioc` **完全没有体积上限**（2 MiB 时约 30 分钟）。CWE-1333 / CWE-407。

**修复**：用循环数尾随反斜杠（`let n=0; while (n < logical.length && logical[logical.length-1-n] === "\\") n++;`）替代正则；并给 `cubemxService.permission()` 补上同样的 ≤1 MiB 守卫。

### 17.4 低危：DWARF 类型解析递归深度无上限；负 `str_offsets_base` 使整个 DWARF 结果作废

- **`src/dwarf/types.js:56-87`**：`_resolveTypeInfo` 沿 `DW_TAG_typedef`/`const`/`volatile`/`restrict` 链递归且无深度参数。递归前 `cache.set(refKey, placeholder)` 使**环**安全，但**链长**无上限。实测：20,288 字节 ELF（4000 个链式 typedef）与 300,288 字节 ELF（60,000 个）均产生 `RangeError: Maximum call stack size exceeded`，`parseDwarf` 降级为 `types: 0`。目前仅因三个公开入口（`dwarf.js:20,28,36`）都包了 try/catch 而未崩溃——未来任一未加保护的调用点都会变成崩溃，且这是抹掉全部变量类型信息的廉价手段。**修复**：加 `depth` 参数，沿用 `forms.js:6` 已有的 ≤32 上限。
- **`src/dwarf/parser.js:62-67`**：`resolveStrx` 的守卫 `if (entryOff + 4 > strOffsets.size)` **没有 `entryOff < 0` 检查**，而 `base` 来自 `DW_AT_str_offsets_base`，`DW_FORM_sdata` 可令其为负 ⇒ `entryOff` 为负 ⇒ 守卫通过 ⇒ Node 抛 `ERR_OUT_OF_RANGE`。已用 452 字节构造 ELF 复现：不崩溃，但 `parseDwarf` 返回 `types: 0` + `DWARF_PARSE_FAILED: The value of "offset" is out of range… Received -8`。由于抛出点在 CU 循环**之后**（`:243-245`），该 ELF 的**全部**类型与布局信息丢失，且每次调用都会重新解析。**修复**：补 `base < 0 || index < 0 || entryOff < 0` 检查，并把循环后的名称解析也包进 try/catch。
- **`elfService.js:39`** `readFileSync` 无体积上限（多 GB 的 `.elf` 会被整份读入内存）——建议解析前加 `statSync().size` 上限。

### 17.5 解析器专项确认「无内存不安全」

所有文件可控偏移要么被显式检查（`elfFormat.js:30-32,55-58`；`elfSymbols.js:219-222,224-232`；`dwarf/binary.js:55-57`；`elfSymbols.js:561,567,587,615`；`compositeValidation.js:41-48`），要么经 Node `Buffer.readUInt*` 抛 `ERR_OUT_OF_RANGE`；`subarray()` 会截断；`buf[i]` 越界返回 `undefined`。`forms.js:11-14` 在每个属性读完后重新校验游标，读取越界即丢弃该值，因此不存在被消费的半读值。**无越界读、无任意读、无内存披露。**

同时确认：LEB128 与游标循环均有 `cur.p >= buf.length` 与 `shift >= 56` 双守卫且每轮必然前进；节/符号计数受 u16 与 `shoff + shnum*shentsize <= len` 约束，无整数溢出；三处 `fast-xml-parser` 调用点均拒绝 `<!DOCTYPE|<!ENTITY` 且 `processEntities:false`（**无 XXE、无 billion laughs**），`maxNestedTags:100` 使 `collectDevices` / `merge` 的递归不可能爆栈；`wildcardMatches` 的正则由 `normalizePart` 过滤为仅含 `[A-Z0-9.]`，无 ReDoS；SVD 展开有 10 万节点全局预算、`dim <= 4096`、`derivedFrom` 环检测与 128 层链守卫；`validateComposite` 把复合展开限制在约 6.5 万叶子；`Buffer.alloc(bytes)` 的 `size ∈ {8,16,32,64}`；`chip/*` 与 `faultInfo` 为面向行的解析，`rawAll` 截断在 400 行，全部正则单行锚定，无输入驱动的数组/循环。本代码库不含 `.eh_frame`/CIE/FDE、`.debug_line` 状态机、tar 或 LZMA 解析器。

### 17.6 归档解压复检

**OpenOCD `.tar.gz` 解压（`openocdInstaller.js:86-92, 124-142`）— 防御有效，但有一处健壮性缺陷。**

关键细节（读 `node_modules/tar@7.5.22` 源码确认）：`Unpack` 在 `super(opt)` 注册用户 `onentry` **之后**才注册自己的 `[ONENTRY]` 钩子（`unpack.js:232` vs `parse.js:150`），因此 **`onentry` 收到的是未经清理的原始 `entry.path`** —— 这使得 `assertSafeEntryPath` 是真正承重的防线，而非冗余装饰。

用构造的 tar 实测（`../escape.txt`、`/abs-escape.txt`、`a/../../escape2.txt`、符号链接 `../../escape-link`、硬链接 `../escape.txt`）：node-tar 跳过 `..` 条目、把绝对路径相对化进 staging、拒绝越界 linkpath，**没有任何内容落到 staging 之外**。守卫只检查 `entry.path` 不检查 `entry.linkpath`，但后者由 node-tar 的 `STRIPABSOLUTEPATH` + `ENSURE_NO_SYMLINK` 覆盖。

**健壮性缺陷（不可利用）**：`assertSafeEntryPath` 抛出的异常会以 **uncaughtException** 逃出 `tar.x()`，而不是走预期的 `{ok:false}` 返回分支（已实测），可能让扩展宿主崩溃。修复：在 `onentry` 里置标志位，`await tar.x()` 之后再检查。

**独立复核托管归档本体**：`resources/openocd-win32-x64.tar.gz` 共 1194 个条目，**全部为普通文件（1132）与目录（62），零符号链接 / 硬链接 / 字符设备**，且无任何 `..` 或绝对路径条目。归档中的文件模式为 `rw-rw-rw-`（污染构建环境的遗留，扩展以当前用户运行，影响可忽略）。

**CMSIS-Pack `.zip`（`officialSvdService.js`）— 结构上免疫 Zip-Slip。** `extractPackEntry` 全程在内存中操作（`:437-461`），**从不把条目写到磁盘**；`safeZipName`（`:361-373`）拒绝 `..` / 空段 / 绝对路径 / 盘符 / 反斜杠；符号链接条目被显式拒绝（`:406-414`）；条目名仅与 `candidate.svd` 比较（`:420`）；重复条目被拒。下载目标是 `mkdtemp()` + 固定 `package.pack`，`flags:"wx"`，有大小上限，仅 HTTPS。

**其他删除 / 清理 sink — 全部安全。** `samplingArchive.js:45-56`（名称被 `^sampling-history-\d+-[0-9a-f]+$` 钉死）、`webviewAssets.js:36-45`（扩展自有根目录，`scope` 取自 `nextLivePanelId`）、`svdLibraryService.js:246-247`（`^[a-f0-9]{64}$`）、`cubemxOperations.js:134-135` 与 `agentBridge.js:53`（sha256 键）。**注意**：`fs.rm(link, {recursive:true})` 只删除链接本身（已实测），所以 `uninstallSkill:275`、`agentBridge.js:91-92`、`skillInstaller:279` 不受 §1 根因影响 —— §1 的问题专属于「先 `readdir` 再删除**条目**」这一模式。

**由工作区 / 配置控制的路径 — 六处 sink 全部 realpath + 包含性校验**：`configurationStore.workspacePath:65-87`、`cubemxCandidate.generateCandidate:169-179`、`cubemxEnvironment.workspaceIoc:124-135`、`cubemxService.plan:150-155`、`debugControlService._sourceLocator:112-124`、`openocdScripts.resolveConfigFile:70-90`、`cubemxProject.snapshot:49-54` + `applyFiles:287-306,315-319`。

**`skills/**` 下的写入 sink 仅两处，均有校验**：`skills/mcu-variables/scripts/read.js:371-399`（拒绝绝对路径、检查 `..`、并**向上走到最近的存在祖先**以击败符号链接父目录）、`skills/mcu-cubemx/scripts/cubemx.js:102-110`（固定相对存储路径）。

**`fzstd` 解压（`src/dwarf/binary.js:59-73`）**：解压进预分配的 `Uint8Array(expectedSize)` 且 `expectedSize ≤ 128 MiB` → 无解压炸弹。

**低危（纵深防御）**：`skillInstaller.js:45,72,92-93,206-209,239,261` 把 `skills/manifest.json` 的 `entry.name` / `entry.files` 键直接拼进路径而未校验。manifest 属于扩展自有资产，**不可利用**；建议套用与归档条目相同的 `^[A-Za-z0-9._-]+$` 校验。`scripts/**` 仅开发期使用且不在 VSIX 的 `files` 列表中。

---

*报告生成：EmberProbe 安全审查。所有结论均基于对实际代码的走查、对真实函数的注入验证，以及对 `node_modules/tar@7.5.22` 等依赖源码的阅读。审查过程未修改任何源文件。*
