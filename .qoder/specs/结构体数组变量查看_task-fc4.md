# 结构体与数组变量查看功能

## 总体思路

当前系统只支持标量类型 (u8/i8/u16/i16/u32/i32/f32)。需要：
1. DWARF 解析增强：提取结构体成员（名称、偏移、类型）和数组维度信息
2. 内存读取增强：按成员/元素的偏移和大小读取并解码
3. UI 增强：侧边栏支持可展开树形显示；图表仍仅标量

---

## 阶段一：DWARF 解析增强 — 提取复合类型成员信息

**文件**: `src/dwarf.js`

当前 `parseDwarfVariableTypes()` 对 struct/union/array 只返回 `{ typeName, watchType: '' }`。需要新增函数 `parseCompositeLayout(buffer)` 返回复合类型的内存布局：

```js
// 返回 Map<变量名, CompositeLayout>
// CompositeLayout = {
//   kind: 'struct' | 'union' | 'array',
//   typeName: string,
//   byteSize: number,
//   members: [{ name, offset, byteSize, typeName, watchType, kind? }],  // struct/union
//   elementType: { typeName, watchType, byteSize },  // array
//   dimensions: [number],  // array 各维度大小
// }
```

实现要点：
- 在现有 DIE 遍历中，对 `DW_TAG_structure_type` / `DW_TAG_union_type` 额外解析其子 DIE（`DW_TAG_member`），提取 `DW_AT_name`、`DW_AT_data_member_location`（成员偏移）、`DW_AT_type`（成员类型引用）
- 对 `DW_TAG_array_type`，解析子 DIE（`DW_TAG_subrange_type`）获取 `DW_AT_upper_bound` / `DW_AT_count` 得到维度
- 递归解析成员类型（复用现有 `resolveType` 逻辑），若成员本身仍是复合类型则记录 `kind` 但不递归展开（UI 层按需展开）
- union 的成员偏移全部为 0

---

## 阶段二：变量计划与内存读取增强

**文件**: `src/elfSymbols.js`

1. 新增 `resolveCompositeRequest(symbols, request)` 函数：
   - 输入变量名 + 可选的选取规格（如 `sensor.x`、`buf[0:3]`、`buf[*]`）
   - 查 DWARF 布局，计算每个叶子成员的绝对偏移和大小
   - 返回扁平化的读取项列表 `[{ name, address, size, type, path }]`

2. 新增 `decodeComposite(bytes, layout)` 函数：
   - 按布局从原始字节中提取各成员/元素的值
   - 返回树形结构 `{ kind, typeName, members: [{ name, value, type }] }` 或 `{ kind: 'array', elements: [...] }`

**文件**: `src/liveWatch.js`

`_readItems` 已有按地址合并连续读取的优化。复合变量拆为多个叶子成员后，同样参与地址合并，无需特殊处理。只需确保 `_readItems` 的输入可以包含同一结构体的多个成员（不同偏移、不同 size）。

---

## 阶段三：扩展主逻辑桥接

**文件**: `src/extension.js`

1. `readElfSymbols()` (line 795)：调用新的 `parseCompositeLayout()`，将布局信息附加到符号对象上 `sym.compositeLayout`
2. 移除 `isComposite` 的"不可用"标记，改为 `sym.isComposite = true` 但保留 `sym.compositeLayout` 供 UI 使用
3. `importVariables` / `resolveVariable` 消息处理：将 `compositeLayout` 一并发送给 webview
4. `onSample` 回调 (line 942)：对复合变量，按布局解码为树形值后发送；新增消息类型 `liveCompositeSample`
5. `_activeReadPlan()` (line 881)：复合变量展开为多个叶子读取项
6. `_addAgentWatch()` (line 529)：支持 `sensor.x` 等成员路径语法

---

## 阶段四：Webview UI — 可展开树形显示

**文件**: `src/liveWatchView.js`

1. **变量卡片改造**：
   - 标量变量保持现有单行卡片
   - 复合变量显示为可展开卡片：默认折叠态显示类型名和总大小（如 `struct Sensor (12B)`），展开后显示成员列表
   - 每个成员行显示：名称、类型、当前值、颜色标记
   - 嵌套结构体支持递归展开（多层折叠）

2. **数组选取交互**：
   - 添加数组变量时弹出选取面板：
     - "全部元素"（默认显示前 16 个，可滚动查看）
     - "指定范围"：输入起始和结束索引
     - "单个元素"：输入索引
   - 选取结果作为变量的子项显示在树中

3. **图表面板限制**：
   - 复合变量整体不出现在图表中
   - 展开后的叶子成员（标量）可以单独拖入/勾选加入图表
   - 实现方式：叶子成员作为独立标量变量加入 `watch` 列表，但 `name` 使用路径（如 `sensor.x`），图表逻辑无需修改

4. **值更新**：
   - `updateValues()` 函数需支持树形遍历，按路径更新叶子节点的值
   - `onSamples()` 处理新的 `liveCompositeSample` 消息

---

## 阶段五：Agent Bridge 与 Skill 适配

**文件**: `src/extension.js` (Agent Bridge 处理)

1. `variables.read` / `variables.sample`：支持 `sensor.x`、`buf[0]` 等路径语法
2. 返回结果中复合变量以树形 JSON 呈现

**文件**: `skills/mcu-live-watch/SKILL.md`

更新文档说明：
- 支持读取结构体成员：`--variables sensor.x,sensor.y`
- 支持读取数组元素：`--variables buf[0],buf[1:5]`
- 支持读取全部元素（默认显示前 16）：`--variables buf[*]`

**文件**: `skills/mcu-live-watch/scripts/read-live.js`

`variableSpecs()` 解析路径语法，`decode()` 支持按偏移读取成员值。

---

## 阶段六：i18n 与测试

**文件**: `src/i18n.js`

新增翻译键：
- `lw.compositeExpand` / `lw.compositeCollapse`：展开/折叠
- `lw.structMember`：结构体成员
- `lw.arrayElement`：数组元素
- `lw.arraySelectTitle`：数组选取面板标题
- `lw.arrayAll` / `lw.arrayRange` / `lw.arraySingle`：选取模式

**文件**: `test/` 目录

- `dwarf-composite.test.js`：验证结构体成员偏移、数组维度解析
- `composite-decode.test.js`：验证复合值的解码正确性

---

## 关键设计约束

1. **内存读取效率**：同一结构体的所有成员合并为一次 `read_memory` 调用（利用现有地址连续合并逻辑）
2. **采样性能**：复合变量不增加额外的 Tcl 往返次数，只在展开读取项时增加叶子数量
3. **向后兼容**：标量变量的行为完全不变；`isComposite` 从"不可用"变为"可展开"
4. **DWARF 降级**：无 DWARF 信息时，复合变量退化为按符号大小显示的原始字节（与当前行为一致）
5. **图表限制**：图表面板仅接受标量，复合变量需展开后选取叶子成员才能入图
