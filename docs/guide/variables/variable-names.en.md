# Variables with the Same Name

[中文](variable-names.md)

`static` variables and anonymous-namespace variables in different source files can share a name. EmberProbe keeps each one and shows which file it came from. This is normal and gives no warning.

## Viewing them

The available variables list, waveform import list and input completion prefer readable names, with the source file in muted text beside duplicates. If file names also match, the shortest distinguishing path appears. Hover for the full name, source path and address.

## Adding to a waveform

Type `g_localConfig` in a waveform panel and press Enter. If several variables match, source candidates appear below the input:

- Click one, or choose with the arrow keys and press Enter, to add it.
- There is no default and nothing is chosen for you.
- Press Escape or edit the input to cancel.

You can also name the source directly:

```text
probe_lab.cpp::g_localConfig
'path/to/probe_lab.cpp'::g_localConfig
```

## Agents

When a name is ambiguous, Agent reads and writes receive `VARIABLE_AMBIGUOUS` with a list of candidates and must name the target.

## Limits

An ELF without debug names shows linker symbol names.

## Related documents

- [Variable identity and origin design (Chinese)](../../design/variable-identity.md)
