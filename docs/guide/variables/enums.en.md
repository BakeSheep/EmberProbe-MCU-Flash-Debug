# Enum Variables

[中文](enums.md)

With an ELF containing debug information, EmberProbe reads C/C++ enum types and shows enum variables as a member name plus value. No configuration is needed.

## How values appear

| Case | Shows |
| --- | --- |
| Plain enum | `ERROR(-1)` |
| Scoped member, such as `app::State::Active` | `.Active(3)`, with a dot replacing the `::` prefix |
| Several members with one value | `ACTIVE / READY(3)` |
| Value not in the enum | The number only |

Enums in struct members, array elements and type aliases work the same way.

## Limits

- Waveforms and CSV keep the number, not the name.
- Enter numbers when writing. Member names are for display only.
- A variable like `int value = ACTIVE` is an integer and shows a number, since its debug type is not an enum.
- An enum without enough type information shows as unavailable rather than being read with a guessed type. Inferred types are read-only.
- Enum tables over 1024 members or with too much name text are not loaded.

## Related documents

- [Variable display design](../../design/variable-display.md)
- [Pointers and C++ members](pointers.en.md)
