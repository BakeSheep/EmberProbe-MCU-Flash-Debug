# Pointers and C++ Members

[中文](pointers.md)

With an ELF containing debug information, the sidebar and waveform panels show what a pointer points to and hide compiler and standard-library internals by default.

## Structs and classes

Only the members you declared are shown. Hidden are compiler-generated members (such as `_vptr.Base`) and standard-library internals (such as `_M_*`). Public members like `std::pair::first` stay visible.

Common library types appear as one row:

| Type | Shows |
| --- | --- |
| `std::atomic<T>` | The stored value |
| `std::array<T, N>` | The elements |
| `std::chrono::duration`, `time_point` | The count |
| `std::unique_ptr`, `shared_ptr`, `weak_ptr` | The managed pointer |
| `std::function` | `empty`, or the target's address and symbol |

When members are hidden you see "N internal members hidden". **Show raw members** reveals every field, per variable. Hiding only affects display, not waveforms, CSV or writes.

## Reading pointers

The value cell shows the target. Hover for the address; click to copy it:

| Target | Shows |
| --- | --- |
| Variable, array element | `&g_widgets[1]` |
| Struct member | `&g_widgets[2].y`, `&grid[1][2]` |
| Offset inside a variable | `&rxBuf+0x3` |
| Function | `clickHandler()`, or `name+0x4` inside it |
| Virtual table | The dynamic class name |
| Read-only string | `"hello"`, up to 64 bytes |
| Peripheral register | `&GPIOA->ODR`, with an SVD bound |
| Flash, RAM or other region with no symbol | `0x20001234`, with the region on hover |
| Outside every known region | `0x12345678` in the warning color |
| Zero | `NULL` |

Strings in RAM appear when you expand the pointer.

## Expanding a pointer

Click the arrow beside a data pointer to show the object below it. Target memory is read only while expanded and stops when collapsed. You can also enter `owner.value`, `owner->field` or `owner.value.field` directly.

- One level expands at a time, and pointers inside the target have their own arrows.
- The target follows the pointer as it changes. While the pointer is `NULL` the arrow is hidden.
- The target type is the declared pointer type, not the actual derived class.
- A `char` pointer shows a string preview of up to 32 bytes.
- `void *`, function pointers and declaration-only types cannot be expanded.
- Expanded targets are read-only, in the UI and for Agents.
- Only memory ranges verified from the ELF are read, never peripheral regions. Unreadable targets show as unavailable.

Pointer variables added to the sampling list start with their curve hidden, since an address rarely means much. Turning a curve on is remembered.

When you reopen a panel, pointers show the last sampled target, dimmed and italic, with "last sampled" on hover. This is only a hint; targets are read once sampling starts.

## Limits

- All of this needs DWARF debug information in the ELF.
- The built-in GDB debugger's variable view is not affected.

## Related documents

- [Variable display design](../../design/variable-display.md)
- [Enum variables](enums.en.md)
