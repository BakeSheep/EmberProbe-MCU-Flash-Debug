# 结构体数组变量查看 — 剩余实现计划

## 当前状态

Phase 1 (dwarf.js)、Phase 2 (elfSymbols.js)、Phase 3 主体 (extension.js)、validation.js、i18n.js 已完成。以下为剩余工作。

---

## 阶段三（收尾）：extension.js Agent Bridge 复合变量支持

**文件**: `src/extension.js`

`_readAgentVariables()` (line ~630) 和 `_sampleAgentVariables()` (line ~650) 当前调用 `_agentVariablePlan()` → `resolveVariableRequests()`，该函数在 elfSymbols.js line 49 拒绝 `isComposite` 变量。需要：

1. 在 `_agentVariablePlan()` 中分离标量和复合变量请求
2. 复合变量请求（含路径如 `sensor.x`）走单独的解析路径：
   - 用 `parseMemberPath()` 解析路径
   - 查找基变量符号，获取 `compositeLayout`
   - 用 `expandCompositeLeaves()` 展开为叶子读取项
3. `_decodeAgentSample()` 对复合变量用 `decodeComposite()` 解码，返回树形 JSON

---

## 阶段四：liveWatchView.js UI 树形显示（核心工作量）

**文件**: `src/liveWatchView.js`

该文件仅 62 行，但包含一个巨大的模板字面量（HTML+CSS+JS 全部内联）。所有修改都在这个模板字面量内。

### 4.1 CSS 新增（在 `</style>` 前插入）

```css
/* 复合变量树形卡片 */
.var-card.composite{grid-template-columns:auto minmax(0,1fr) auto;padding:5px 7px}
.comp-header{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.comp-header .arrow{font-size:10px;transition:transform .15s;color:var(--vscode-descriptionForeground)}
.comp-header .arrow.open{transform:rotate(90deg)}
.comp-type{color:var(--vscode-symbolIcon-variableForeground,#4fc1ff);font:11px var(--vscode-editor-font-family)}
.comp-size{color:var(--vscode-descriptionForeground);font:10px var(--vscode-editor-font-family)}
.comp-members{display:none;padding:2px 0 2px 18px;border-left:2px solid var(--vscode-widget-border,transparent);margin:4px 0 0 4px}
.comp-members.open{display:block}
.member-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:5px;padding:2px 4px;border-radius:3px;font-size:12px}
.member-row:hover{background:var(--vscode-list-hoverBackground)}
.member-name{font:12px var(--vscode-editor-font-family);color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.member-type{font:10px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground)}
.member-value{font:650 13px var(--vscode-editor-font-family);color:var(--vscode-symbolIcon-numberForeground,#b5cea8);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.member-row.nested{margin-left:12px;border-left:1px solid var(--vscode-widget-border,transparent);padding-left:6px}
/* 数组选取面板 */
.array-overlay{position:fixed;z-index:20;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)}
.array-panel{padding:16px;border-radius:6px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);min-width:280px}
.array-panel h4{margin:0 0 10px}
.array-panel label{display:block;margin:6px 0;cursor:pointer}
.array-panel input[type=number]{width:70px;margin:0 4px}
```

### 4.2 修改 `addSymbol()` (line 41 内联 JS)

当前代码：
```js
if(sym.isComposite){setStatusMsg(...);return}
```

改为：
- 复合变量加入 `watch` 数组，附带 `isComposite:true, compositeLayout, expanded:false`
- 如果是数组类型且无路径规格，弹出数组选取面板（见 4.4）
- 如果是结构体/联合体或有布局的数组，直接加入

### 4.3 修改 `renderVars()` (line 43 内联 JS)

当前逻辑：为每个 watch item 创建扁平卡片。

改为：
- **标量变量**：保持现有单行卡片（不变）
- **复合变量**：渲染可展开卡片
  - 卡片头部：展开/折叠箭头 + 类型名 + 总大小 + 移除按钮
  - 展开后：`<div class="comp-members open">` 包含成员行
  - 每个成员行：成员名 + 类型 + 当前值（从 `latest[variableName].members[i].value` 取）
  - 嵌套复合成员：递归渲染，加 `.nested` class
  - 叶子成员旁放一个小按钮，可将其单独加入图表

### 4.4 数组选取面板

新增函数 `showArraySelectDialog(sym, callback)`：
- 弹出 overlay 面板，三种模式：
  - 全部元素（默认显示前 16 个）
  - 指定范围（start/end 输入框）
  - 单个元素（index 输入框）
- 确认后 callback 带 pathSpec 参数

### 4.5 处理 `liveCompositeSample` 消息

在 message handler (line 56) 新增：
```js
else if(m.type==='liveCompositeSample') onCompositeSamples(m.samples||[])
```

新增函数 `onCompositeSamples(samples)`：
- 遍历 samples，更新 `latest[s.name] = s.tree`
- 如果对应卡片已展开，更新成员值 DOM

### 4.6 修改 `renderImport()` (line 49)

当前：`cb.disabled=!!s.isComposite`

改为：复合变量不再禁用 checkbox，但显示标记：
- 有 `compositeLayout` 的复合变量：checkbox 可用，名前加 ◇ 标记
- 无布局的复合变量：checkbox 仍禁用，显示原因

### 4.7 `updateValues()` 改造

当前：直接设 `valueCells[n].textContent = fmtNum(latest[n])`

改为：
- 标量变量：保持现有逻辑
- 复合变量：遍历树形值，更新各成员 value cell

### 4.8 watch 数据结构扩展

watch item 新增字段：
```js
{
  name, address, size, type,  // 现有
  isComposite: true,           // 复合标记
  compositeLayout: {...},      // 布局信息
  expanded: false,             // UI 展开状态
  pathSpec: null               // 数组选取规格（可选）
}
```

### 4.9 `saveWatch()` / `loadWatch()` 兼容

复合变量的 `compositeLayout` 和 `expanded` 状态需要持久化。`saveWatch` 发送完整 watch items 到扩展侧存储。

---

## 阶段五：Agent Bridge 与 Skill 适配

### 5.1 `src/extension.js` — Agent Bridge 复合变量

`_readAgentVariables()` 和 `_sampleAgentVariables()` 当前通过 `_agentVariablePlan()` → `resolveVariableRequests()` 处理，该函数拒绝复合变量。

修改方案：
- `_agentVariablePlan()` 中先分离出复合变量请求（含路径语法）
- 复合变量请求走新路径：`parseMemberPath()` → 查符号 → `expandCompositeLeaves()` → 生成读取项
- `_decodeAgentSample()` 对复合变量用 `decodeComposite()` 返回树形 JSON

### 5.2 `skills/mcu-live-watch/SKILL.md`

新增文档段落：
```markdown
## Struct members and array elements

You can read individual struct members or array elements using path syntax:
--variables sensor.x,sensor.y
--variables buf[0],buf[1:5]
--variables buf[*]
```

### 5.3 `skills/mcu-live-watch/scripts/read-live.js`

`variableSpecs()` (line 36) 当前按 `:` 分割 name:type。需要支持路径语法中的 `:` (range)，改为：
- 先检查是否含 `[` 或 `.`，若有则按路径语法解析
- 否则按现有 name:type 解析

---

## 阶段六：构建验证

1. 运行 `node -e "require('./src/dwarf'); require('./src/elfSymbols'); require('./src/extension');"` 验证无语法错误
2. 检查所有新增 i18n 键在 liveWatchView.js 中被正确使用
3. 确认 `liveCompositeSample` 消息格式在 extension.js 和 liveWatchView.js 之间一致

---

## 关键文件修改清单

| 文件 | 修改量 | 说明 |
|------|--------|------|
| `src/extension.js` | ~30行 | Agent Bridge 复合变量路由 |
| `src/liveWatchView.js` | ~200行 | UI 树形显示（CSS+HTML+JS） |
| `skills/mcu-live-watch/SKILL.md` | ~15行 | 文档更新 |
| `skills/mcu-live-watch/scripts/read-live.js` | ~30行 | 路径语法支持 |
