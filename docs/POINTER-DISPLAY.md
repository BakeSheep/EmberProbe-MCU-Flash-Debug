# Pointers and C++ internal members

With an ELF containing DWARF debug information, the sidebar and Live Watch show pointers
as addresses and hide compiler and standard-library internals by default. No source
parsing, GDB evaluation or extra target reads are needed for this; only the on-demand
dereference described below reads target memory.

## Default member view

Composite variables show the members a user declared. Two kinds of members are hidden by
default:

- **Compiler-generated** members: DWARF `DW_AT_artificial` members such as `_vptr.Base`
  (also recognized by the `_vptr` name when the attribute is missing).
- **Standard-library internals**: reserved-name members (`_M_*`, `__*`) and base classes of
  types in `std::` and `__gnu_cxx::`. Public members such as `std::pair::first` stay visible.

Some library types are shown as one row instead of their internals:

| Type | Row shows |
| --- | --- |
| `std::atomic<T>` | the stored value (`_M_i`) |
| `std::array<T, N>` | the elements (`_M_elems`) |
| `std::chrono::duration` / `time_point` | the count (`__r` / `__d`) |
| `std::unique_ptr` / `shared_ptr` / `weak_ptr` (static layouts) | the managed pointer |
| `std::function` | `empty`, or the invoker address with its symbol annotation |

Each composite with hidden members shows "N internal members hidden" and a **Show raw
members** toggle. The toggle is per variable and restored with the view state. Raw mode
shows exactly the full DWARF expansion.

Hiding changes presentation only. Watch, chart and CSV identities keep the raw path, for
example `motor.state.@base0._M_i` is labelled `motor.state`. Saved watch lists that refer to
internal paths keep rendering and sampling. Write rules are unchanged.

## Pointer values

Pointer members and pointer variables are tagged in DWARF metadata with their target kind
(`data`, `void`, `function`, or for runtime graphs `incomplete`). They are shown as
`0x%08X`; zero is shown as `NULL`. The type badge shows the declared type, such as
`Widget *` or `TaskHandle_t`. Charts and CSV keep the numeric value; `valueText` carries
the hexadecimal text.

The host annotates pointer values from the ELF symbol table without reading the target:

- function pointers: `→ clickHandler`, or `→ name+0x4` inside a function (Thumb bit cleared)
- data pointers: `→ &rxBuf[12]` for array elements, `→ &object+0x10` otherwise
- virtual table pointers: the dynamic class name
- otherwise the memory region: Flash, RAM, Peripheral (`0x40000000–0x5FFFFFFF`),
  System (`0xE0000000+`), or invalid

Annotations are cached per ELF (SHA-256) in a bounded LRU and refreshed when symbol
metadata changes. They are display hints only and never grant read or write authority.

## On-demand dereference

A data pointer row has a **↳** button. It adds a read-only watch for the pointed-to object,
named `<path>.value` and labelled `*<path>`. The same paths can be entered directly:
`owner.value`, `owner->field` or `owner.value.field`.

- Only one level is followed per request. Pointers inside the target remain addresses with
  their own **↳** button.
- `void *`, function pointers and pointers to declaration-only types cannot be followed.
- The target type is the pointer's static type.
- Each sample re-reads the pointer, so the target follows the pointer as it changes.
- A dereferenced `char` shows a string preview of up to 32 bytes, escaped, ending at the
  first NUL or at the end of the verified memory range (truncation is marked with `…`).
- Reads use the runtime reader limits: addresses must lie in verified allocated ELF ranges
  (MMIO targets are rejected before any read), and each cycle is bounded to 4096 bytes,
  32 reads and a time budget. A null or unreadable target is reported as unavailable.
- Dereferenced targets are never write destinations, in the UI or through the Agent Bridge.

Inside STL containers, pointers that cannot be followed (opaque targets, cycles, budget
exhaustion, unreadable memory) become local address rows with a reason instead of failing
the whole variable.

## Agent Bridge

Decoded trees keep every raw member. Members carry `memberRole` (`artificial` or
`internal`) when the UI hides them by default, library objects carry `stdSummary`, and
pointer leaves carry `isPointer`, `pointerTarget`, a hexadecimal `valueText` and, when
available, `pointerText` / `pointerInfo`.

## Validation

`node test/member-roles.test.js`, `node test/pointer-display.test.js`,
`node test/pointer-symbolizer.test.js`, `node test/pointer-deref.test.js` and
`node test/runtime-pointer-fallback.test.js` use a GCC 15.2 ARM fixture
(`test/fixtures/pointer-classes/`, regenerate with `node scripts/build-pointer-fixture.js`)
for DWARF 4 and 5. These tests do not establish board support. The built-in GDB debugger's
variable view is unchanged.
