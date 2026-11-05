# 同名变量

[English](variable-names.en.md)

不同源文件里的 `static` 变量或匿名命名空间变量可以同名。EmberProbe 保留每一个，并显示它们来自哪个文件，这是正常情况，不会警告。

## 查看

可用变量列表、波形导入列表和输入补全优先显示可读名称，同名项旁边用淡色显示来源文件。文件名也相同时显示最短能区分的路径。悬停可以看完整名称、源路径和地址。

## 添加到波形

在波形窗口输入 `g_localConfig` 并按 Enter。匹配多个变量时，输入框下方列出来源候选：

- 点击候选，或用方向键选中后按 Enter，才会添加。
- 没有默认项，不会自动选择。
- 按 Escape 或编辑输入可以取消。

也可以直接写明来源：

```text
probe_lab.cpp::g_localConfig
'path/to/probe_lab.cpp'::g_localConfig
```

## Agent

名称有歧义时，Agent 读写会收到 `VARIABLE_AMBIGUOUS` 和候选列表，必须明确指定目标。

## 限制

ELF 缺少调试名称时显示链接符号名。

## 相关文档

- [变量身份与来源分类设计](../../design/variable-identity.md)
