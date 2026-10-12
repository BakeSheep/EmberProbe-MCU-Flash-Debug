# DWARF layout resolution / DWARF 布局解析

Static layouts and runtime recipes share normalized type references and array dimensions. A zero-length
array has a zero count and byte size; it does not suppress the containing structure's other members.
The parser recognizes signed -1 and all-ones data4/data8 upper bounds (GCC's -1 of the 32-bit sizetype)
using the effective attribute form, including indirect forms. data1 0xff and data2 0xffff are ordinary
bounds: GCC encodes uint8_t a[256] as data1 255.

静态布局和运行期类型图共用规范化类型引用与数组维度。零长度数组的元素数和大小均为零，
不影响外层结构体的其他成员。上界的零长度标记（-1 或 data4/data8 全 1）按实际 form 宽度识别，也支持间接 form；data1/data2 全 1 是普通上界。

## Declaration identity / 声明身份

Class/struct declarations share a definition family; unions and enums have separate families.
Definitions are indexed by qualified name, compilation unit and local scope. A definition referenced
by DW_AT_specification supplies the declaration's nested scope and name. Named declarations remain
declarations: references are redirected without changing their tags to typedef.

同 CU 的定义优先。跨 CU 仅关联公开作用域内的唯一完整定义，或存储身份一致的多个定义。
匿名 namespace、函数及 lexical block 中的类型保留真实局部作用域身份，不跨 CU 猜测关联。
候选不一致、类型缺失或比较预算不足时，声明继续使用不可展开的只读回退。

Candidate groups are limited to 64 definitions. Each structural comparison stops after 16,384 visits
(including children), 64 levels, or oversized metadata, and all comparisons for one ELF share a total
cap of 1,048,576 visits; comparison failure never selects a partial definition. Variable binding uses
the same bounded comparison, byte size and type flags to report ambiguous symbols before layout
expansion. Same-named statics at different addresses are not ambiguous when their types match.

## Runtime failures / 运行期失败

A runtime graph retains the 4,096-type and 128-level limits. Runtime array nodes record their count
without expanding elements, so they carry no element-count limit; readers cap the elements they visit. Limited branches produce a symbol-specific runtime-layouts diagnostic and a partial graph while
preserving other fields, static layouts and display names, both in parseDwarf and ELF Worker responses.
Genuine parse failures remain symbol-specific and preserve static layouts.

Only roots containing vptr fields need a vtable catalog. Candidates are indexed once per resolver.
Their graphs are included atomically within the existing type budget. If the catalog or its graphs
exceed the budget, all optional dynamic entries are discarded; consumers cannot verify a dynamic
identity and use their existing unavailable/read-only fallback.

运行期图失败只影响对应变量的运行期布局。动态目录超预算时撤回整份目录，保留完整的根图，
不会把截断的动态类型当作可写布局。运行期读取的内存范围、时间、字节及命令预算保持原约束。

## Split files and locations / 分离文件与位置

Companion lookup tries the ELF-relative name, the compilation-directory-relative name and the
basename beside the ELF. Every candidate must stay beneath the ELF directory before lookup, and its
final realpath must stay beneath that directory as well. An explicitly escaping dwo_name remains
invalid. Compilation-unit dwo_id validation and shared byte limits remain required.

Only an exact single DW_OP_addr, DW_OP_addrx or DW_OP_GNU_addr_index expression represents a static
location. Expressions containing additional operations do not create static-address variables.

## Verification / 验证

- node test/dwarf-audit-regressions.test.js covers the seven audited defects with synthetic ELF/DIE
  fixtures, including scope isolation, comparison limits, dynamic catalog rollback, Worker diagnostics
  and companion traversal/symlink rejection.
- node test/dwarf-formats.test.js retains compilation-unit identity mismatch coverage.
- node test/runtime-native-layouts.test.js exercises existing ARM libstdc++ fixtures without a compiler.
- npm run check and npm run quality remain required; thresholds stay unchanged, and the new regression
  suite is registered in the normal integration test group.
- Native compiler verification can use arm-none-eabi-g++ with -g -gdwarf-4 / -gdwarf-5, -mcpu=cortex-m4
  -mthumb -O0 -fno-rtti -fno-exceptions -fno-use-cxa-atexit -nostdlib -Wl,--entry=main across separate
  declaration and key-function CUs. For split files, compile from a parent directory with
  -gsplit-dwarf -c source.cpp -o build/source.o and place the linked ELF in build/.

Compiler-generated ELF inspection verifies metadata behavior; it does not execute firmware or establish
real-board support.


## Partial composite layouts / 部分复合布局

Static expansion allows 32 composite edges, 16,384 node/member visits and 2 MiB of charged metadata
per root. The metadata allowance reserves marker/handle room before serialization. Typedef and
const/volatile/restrict wrappers do not consume composite depth; iterative alias resolution stops
after 256 wrappers. Arrays and base classes count as composite edges. Sibling rows are reserved
before recursion, and branches receive bounded shares of remaining work. A root whose own member
rows cannot fit still fails with DWARF_BUDGET_EXCEEDED.

A limited member or array element keeps its name, type and size, without compositeLayout.
Its stable unobservable code is depth-limit, expansion-budget or type-cycle. The last code identifies
malformed by-value recursion separately from depth. Ancestor layouts carry truncated: true.
Unavailable entries produce no decoded scalar values, leaf addresses, watch/write targets or curve
controls. Sidebar and live-watch trees/imports display localized reasons. Existing virtual-base and
unsupported member-location restrictions remain in force.

The 64-entry / 65,536-node LRU stores only complete subtrees, including their build depth, visit cost,
original nodeRoom and byteRoom. A cache hit requires depth <= cached.depth and at least the original
node/byte room. Merely fitting the cached cost is insufficient: fair-share branch budgets can make
a fresh build stricter. Otherwise the type is rebuilt with the current allowance. Same-name candidates each receive a fresh identical root budget before JSON
identity comparison. Query order, partial results and LRU eviction therefore do not change layouts. Type metadata uses a
separate 256-edge cap and caches only complete results whose dependency height fits the current
position, so long array/pointer chains cannot poison shallower metadata queries.

静态布局允许 32 层复合边、每个根 16,384 次节点/成员访问；typedef/cv 包装单独以迭代方式限制为 256 跳。
展开前预留兄弟条目，深度或节点预算只截断当前分支。循环值类型使用独立 type-cycle 代码。
父布局传播 truncated 标记；不可观测节点没有标量值、叶子地址、写入目标或曲线按钮，界面展示中英文原因。
根类型自身条目都无法容纳时仍可拒绝。缓存只保存完整子树，并检查构建深度与原始 nodeRoom/byteRoom；仅容纳已缓存成本不足以保证公平分配预算下的查询顺序一致性。

### Runtime recipes / 运行期布局

Runtime graphs retain the 4,096-type and 128-level caps, with a 16,384-visit field/work cap, a 2 MiB metadata allowance and the
same independent alias cap. Limited graph branches reference unavailable nodes and carry the same
machine codes; other fields remain available. Three reserved unavailable-node slots keep the total
type count within 4,096. Template argument references and pointer targets may legally reference
existing types; only by-value layout edges count as malformed cycles. A limited graph sets
truncated: true and reports a symbol-specific diagnostic. Optional vtable catalogs remain atomic:
any limited candidate rolls back the entire catalog, preserving verified dynamic identity checks.

Runtime sampling retains its memory-range, 4,096-byte, 32-command and time checks. Tree expansion
allows 32 levels / 256 visits, reserves sibling rows and returns unavailable branches when expansion
work is exhausted. Explicit unavailable-member reads fail; other fields can still be sampled.
Software fixtures do not establish board support.

运行期图限制仍为 4,096 个类型、128 层；字段/工作访问额外限制为 16,384 次。只截断受限分支，
动态 vtable 目录仍整体回退。采样树的深度为 32 层、访问上限 256 次；内存范围、字节、命令与时间约束保持生效。

### Detached on-demand API / 独立按需展开 API

Worker replies attach expansionHandle to depth/budget-limited composite entries. Handles contain
a scoped opaque reference and an HMAC signature; raw DIE offsets are not accepted. They are
issued only after candidate identity comparison, and a new Worker gets a new signing scope.
Cycle entries have no expansion handle.

ElfService.layout(name) returns expansionGeneration on its root. Call
ElfService.expandLayout(handle, expansionGeneration) to build a detached sublayout with a fresh
32-level / 16,384-node budget. Service and Worker validate handle shape and generation. Invalid
tokens fail with INVALID_LAYOUT_HANDLE; changed generations or Worker scopes fail with
STALE_LAYOUT_HANDLE. Pending expansions reject on ELF invalidation, and invalid handles never enter
the symbol layout-error cache. The Worker preserves the 4 MiB serialized-response cap.

### UI, paths and reads / 界面、路径与读取

Sidebar variable browsing, live-watch import and selected composite trees (including STL roots)
offer **Load more members** on depth/budget nodes with a handle. A shared controller de-duplicates requests by symbol
and concrete path and localizes loading, retry, stale-ELF and budget failures. Cycles and unknown
locations stay unavailable. Successful replies are broadcast to other views; late replies are ignored
even when the ELF content hash is unchanged but the Worker generation changes.

ElfService.expandSymbolLayout(name, path, handle, generation) first validates the symbol/path grammar
and binds the handle to the exact reachable truncated node. It never accepts an address from the
webview. The expanded byte size must equal the original node's storage size, and validateComposite
checks the detached subroot against that size/address before publishing it. Each symbol holds a
layoutExpansions object mapping canonical concrete paths to independent layouts, plus
layoutExpansionGeneration. The root object is unchanged. Each subroot keeps its own 32-edge,
16,384-node and response bounds. One symbol may retain at most 32 subroots and 8 MiB of serialized
metadata, including nested expansions; concurrent requests reserve count slots and duplicate requests
share one promise. The existing 128-pending Worker-request cap remains in force.

Host leaf navigation, anonymous-member lookup, watch normalization, chart history and composite
decoding consult the same branch substitution helper used by both webviews. Explicitly expanded
static leaves remain selectable alongside semantic STL entries; these by-value paths read verified
static storage without pointer chasing and do not claim that a union/variant alternative is active.
Bridge scalar reads for these paths read only the leaf width, rather than the entire parent symbol.
Selected static leaves remain visible separately when their root uses a semantic runtime tree. A branch at
axes[1].a.b remains distinct from axes[0].a.b. Addresses accumulate the symbol base, all member and
base-class offsets and each concrete array index times its element stride before entering a detached
subroot. Offsets inside that subroot remain relative to its original branch. Expanded anonymous
branches retain a concrete .? path segment in layout navigation, decoded trees and UI value updates;
healthy anonymous members still use existing promoted paths. Consumers additionally
cap work at 65,536 visits and 256 composite/path levels. Sparse truncated arrays visit only expanded
indices, so large unavailable arrays do not consume the budget of healthy sibling fields.

Maps and pending work are cleared on ELF invalidation. Saved watch/write lists contain the canonical
name/path, scalar type preference, optional bitfield selection and an expanded-path marker. Existing
write-input range/value preferences are retained. Addresses,
sizes, runtime graphs, layouts, expansion handles and subroots are derived, never persisted, including
during rebind. On reload all selections
are normalized against fresh metadata. A previously expanded path survives only if current static or
semantic runtime metadata can safely resolve it; otherwise it is removed and reported with the
localized invalid-watch message. No automatic handle replay or address restoration occurs. A user
can expand the new tree and select the leaf again.

界面为带签名 handle 的深度/预算分支提供“加载更多成员”，共用请求去重和中英文加载/错误状态。
子布局按符号、具体路径与 ELF generation 独立保存，根布局保持不变；每符号上限为 32 个子根与
8 MiB 元数据。地址先累计符号地址、数组 stride、成员与基类偏移，再加子根内偏移。
ELF 更新清空映射与在途请求；保存的观察列表只有身份与展开路径标记，不保存 handle 或布局。
重载后不能从当前元数据安全解析的旧观察路径会被移除并明确报告。

### Writes and Agent Bridge / 写入与 Agent Bridge

Verified static scalar leaves reached through expansions use the existing typed write path and full
writeAuthorization fingerprint (ELF identity, connection, canonical member path, absolute address,
type and encoded value). Read-only ancestor/element qualifiers propagate through subroots. Writable
RAM section checks, inferred-enum/reference/member-pointer/bitfield restrictions and confirmation
plus human approval remain unchanged. Symbols with runtime/STL recipes remain refused for writes.
UI write entries are revalidated by the host; expanding a branch does not authorize a write.

Agent Bridge variables.read, variables.sample and watch.add use the same current symbol maps as UI
reads/watches. **There is no new Bridge expansion endpoint: paths below truncated nodes require UI
expansion first in the sidebar or live-watch member browser.** Agents can then read/watch supported
canonical paths (and request authorized static writes), but must request new UI expansion after an
ELF reload if a path is unavailable. Whole-variable reads may return partial trees. Existing Bridge
authentication, trusted-workspace checks, input validation and read budgets are unchanged.

已验证的静态叶子可以按现有类型、可写 RAM 与授权指纹路径请求写入；展开本身不授权写入。
runtime/STL 变量的写入拒绝保持不变。Agent Bridge 与 UI 共用当前展开映射，但没有新增 Bridge
展开接口；截断节点下的路径须先由用户在界面展开，ELF 更新后不可用的路径须重新展开。

### Regression coverage / 回归覆盖

- node test/dwarf-deep-layout.test.js: variant-like Axis arrays, sibling preservation, aliases,
  cycles, node bounds, cache order/eviction and leaf/watch/decoded/UI consumer safety.
- node test/dwarf-layout-expansion.test.js: real Worker/service handle round trips, invalid signatures,
  stale ELF generations, unknown references and actual Agent watch/write-path rejection.
- node test/dwarf-budget.test.js and node test/dwarf-audit-regressions.test.js: bounded partial static
  and runtime results, genuine oversized-root failures and atomic dynamic-catalog rollback.

- node test/layout-expansion-host.test.js: message validation/broadcast, real Worker recursive windows, generation changes and malformed response rejection.
- node test/layout-expansion-paths.test.js: array/base offsets, watches/read plans/decode/history, independent subroots, reload persistence/refusal, count/byte caps and authorized typed writes.
- node test/layout-expansion-ui.test.js: both webviews in Chinese/English, load controls, nested expansion, loading/error/stale states and leaf selection.

Final UI continuation validation is recorded in
[the deep-layout plan](plans/2026-10-11-deep-composite-layout.md#continuation-verification-results).
npm run check, npm run quality and git diff --check pass, including the new focused suites and the
C++17/20 x DWARF4/5 paused-GDB software matrix. Bundle and Extension Host E2E remain unverified because
native esbuild cannot read a parent directory under the current sandbox filesystem restriction.
