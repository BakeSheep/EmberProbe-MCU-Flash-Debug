# 变量显示设计

用户操作见[指针与 C++ 成员](../guide/variables.md#指针与-c-成员)和[枚举变量](../guide/variables.md#枚举变量)。本页描述侧栏与波形窗口的值树、显示身份及读取边界，内置 GDB 的变量视图使用独立路径。

## 默认成员视图

复合变量默认显示用户声明的成员。以下成员默认隐藏。

- **编译器生成成员。** 依据 DWARF 的 `DW_AT_artificial`，包括 `_vptr.Base` 等虚表指针。缺少属性时也识别 `_vptr` 命名。
- **标准库内部成员。** 隐藏 `std::` 和 `__gnu_cxx::` 类型的保留名成员（如 `_M_*`、`__*`）及基类。公开成员如 `std::pair::first` 保留。

部分标准库类型对外呈现有效值。

| 类型 | 显示内容 |
| --- | --- |
| `std::atomic<T>` | 存储值（`_M_i`） |
| `std::array<T, N>` | 元素（`_M_elems`） |
| `std::chrono::duration` / `time_point` | 计数（`__r` / `__d`） |
| `std::unique_ptr` / `shared_ptr` / `weak_ptr`（静态布局） | 管理的指针 |
| `std::function` | 空状态或调用函数的地址和符号注解 |

隐藏成员的数量和「显示原始成员」开关按变量显示。开关随视图状态恢复，开启后显示完整 DWARF 展开结果。显示名允许省略内部路径，例如将 `motor.state.@base0._M_i` 显示为 `motor.state`。观察、绘图、导出和已保存列表仍使用原始路径，写入可用性由独立规则判定。

## 指针值与符号注解

DWARF 元数据将指针目标标记为 `data`、`void`、`function`，运行时类型图还支持 `incomplete`。类型标签显示声明类型，例如 `Widget *` 或 `TaskHandle_t`。波形与 CSV 保留数值，`valueText` 保存十六进制文本。

值单元格优先显示目标名称。悬停显示 `0x%08X → <完整目标>`，点击值可复制地址。

| 指针目标 | 显示示例 | 来源 |
| --- | --- | --- |
| 数据符号或数组元素 | `&g_widgets[1]` | ELF 符号 |
| 数据对象内部成员 | `&g_widgets[2].y`、`&grid[1][2]` | ELF 符号和 DWARF 布局 |
| 标量内部或填充字节 | `&rxBuf+0x3`、`&g_square.w+0x2` | ELF 符号 |
| 函数 | `clickHandler()` 或 `name+0x4`（清除 Thumb 位） | ELF 符号 |
| 虚表 | 动态类名 | ELF 符号或运行时类型图 |
| 指向只读数据的 `char *` | `"hello"`，最多 64 字节并转义 | ELF 文件 |
| 外设寄存器 | `&GPIOA->ODR` | 已绑定的 SVD |
| 已知区域内无符号的地址 | `0x20001234`，悬停显示区域 | ELF 节 |
| 已知区域之外 | `0x12345678`，以警告颜色显示 | 地址 |
| 零值 | `NULL` | 地址 |

解析成员路径时优先使用起始地址匹配的最外层对象。遇到 union 和位域时以字节偏移结尾。布局尚未载入时宿主只发一次请求，后续样本可带成员路径。单元格省略命名空间，悬停保留限定名。

只读 C 字符串的预览来自 ELF 中已分配且只读的 `PROGBITS` 节。文件在解析后发生变化时不使用该预览。它表示文件内容，不能证明目标 Flash 中的字节一致。RAM 字符串由指针展开后读取。外设名称来自工作区绑定的 SVD，每次采样按绑定加载一次。

宿主添加 `pointerText`、结构化的 `pointerInfo` 以及可用的 `pointerString`。`pointerInfo.kind` 可为 `data`、`function`、`vtable`、`peripheral`、`region` 或 `invalid`。数据目标还可附 `memberPath` 和 `memberOffset`。符号注解本身无需读取目标，并按 ELF SHA-256 放入有界 LRU，符号元数据变化时刷新。注解只用于显示，读取和写入仍各自校验地址与权限。

## 展开指针

数据指针在当前变量行下展开目标。成员指针和单独观察的指针均可展开，初次显示时按需加载类型图。展开使用 `<path>.value` 观察路径，收起时撤销本次展开及其子项。可直接添加 `owner.value`、`owner->field` 或 `owner.value.field`。若列表只保存目标而缺少可见的指针行，目标显示为独立卡片。

- 每次请求按当前展开路径跟随指针。目标内的指针各有展开入口。无法展开 `void *`、函数指针或仅有声明的类型。
- 读取从指针声明类型出发。运行时类型图能验证受支持的派生类型及布局时，可显示对应的成员。
- 每个样本重新读取指针并解析目标。指针为 `NULL` 时隐藏该目标，读不到目标时以不可用状态呈现。
- 标量目标占一行（`*name`），在波形窗口默认隐藏曲线。解引用的 `char` 最多预览 32 字节，遇 NUL 或已验证内存边界停止，截断以 `…` 标识。
- 目标地址须通过 ELF 区域验证，MMIO 在实际读取前即被拒绝。运行态周期受 4096 字节、32 次读取和时间预算限制。已跟随的 STL 内部指针在对应行下显示，默认收起。类型不透明、循环引用、预算耗尽和内存不可读只影响对应分支。
- 指针存储本身不可写。通过解引用定位的合法动态标量可经侧栏或 Agent Bridge 写入，仍须按[动态成员写入设计](dynamic-variable-writes.md)校验目标、类型、地址和会话。

## 恢复观察列表

保存的观察列表保存身份。重开后，采样前可先按 ELF 类型图复建行。运行时复合对象的指针行以占位状态显示，已保存的 `<path>.value` 在其下方恢复。采样返回地址后才可绘制占位行。

视图状态最多缓存 512 个最近采样的指针目标，ELF 变化或变量移除时清理。采样开始前可用淡色斜体显示，悬停标注上次采样。该缓存是显示提示，不能触发内存读取。

独立指针曲线默认隐藏，用户修改可见性后随视图恢复。启用历史记录的波形消息 `chartValues` 与 `liveSample` 携带同样的指针注解。

## Agent Bridge 数据

解码树保留所有原始成员。界面默认隐藏的成员带 `memberRole`（`artificial` 或 `internal`），标准库对象带 `stdSummary`，指针叶子带 `isPointer`、`pointerTarget` 和十六进制 `valueText`。有符号注解时附 `pointerText`、`pointerInfo` 和 `pointerString`。

## 枚举

ELF 含 DWARF 时解析 C/C++ 枚举类型与成员值。侧栏与波形值栏可显示 `ERROR(-1)` 或 `.Active(3)`。限定名 `app::State::Active` 在界面省略前缀，完整名称仍留在 DWARF 元数据中。同值成员合并显示，如 `ACTIVE / READY(3)`。枚举表中不存在的值按数值显示，以枚举项初始化的普通整数仍按其自身调试类型显示。

支持 typedef/using、const/volatile、复合成员、数组和受支持的运行时对象。运行时路径和 RAM 校验继续决定可观察范围。实时显示只依赖 DWARF，无需解析源码或由 GDB 求值。

图表与 CSV 使用数值，精确的 64 位十进制文本与枚举标签分别保留。写入按既有授权接受数值。旧 DWARF 缺少编码时，有负枚举项按有符号读取，其余按无符号原始值读取。这类推断的类型只读，无法确定编码时返回不可用。超过 1024 个成员或名称和常量文本超过 64 KiB 时，枚举表受 DWARF 预算拒绝。

## 验证边界

`test/member-roles.test.js`、`test/pointer-display.test.js`、`test/pointer-symbolizer.test.js`、`test/pointer-deref.test.js` 和 `test/runtime-pointer-fallback.test.js` 使用 GCC 15.2 ARM 的 DWARF 4/5 测试数据（`test/fixtures/pointer-classes/`，通过 `node scripts/build-pointer-fixture.js` 生成）。`test/pointer-targets.test.js` 使用 `test/fixtures/pointer-targets/` 覆盖符号、字符串、外设和原位展开，参数 `pointer-targets` 可重新生成。

`test/enum-variables.test.js` 覆盖解码与两个 Webview。`test/gdb/enum-variables.test.js` 使用 `arm-none-eabi-gcc` 和 `arm-none-eabi-g++`（或 `IMAGE_CC`/ `IMAGE_CXX`）生成 ARM ELF。动态派生类型和可写标量的规划另由 `test/runtime-write-plan.test.js` 验证。板卡兼容性须单独验收。
