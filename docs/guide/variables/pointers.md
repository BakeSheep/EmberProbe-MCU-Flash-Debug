# Pointers and C++ internal members

With an ELF containing DWARF debug information, the sidebar and Live Watch show what a
pointer points to and hide compiler and standard-library internals by default. No source
parsing, GDB evaluation or extra target reads are needed for this; only expanding a
pointer, described below, reads target memory.

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
(`data`, `void`, `function`, or for runtime graphs `incomplete`). The type badge shows the
declared type, such as `Widget *` or `TaskHandle_t`. Charts and CSV keep the numeric value;
`valueText` carries the hexadecimal text.

The value cell shows the target instead of the address, so pointer rows stay readable in a
narrow sidebar. The address stays available: the tooltip shows `0x%08X → <full target>`
and clicking the value copies the address.

| Target | Cell | Source |
| --- | --- | --- |
| Data symbol, array element | `&g_widgets[1]` | ELF symbols |
| Member or element inside a data symbol | `&g_widgets[2].y`, `&g_square.span.hi`, `&grid[1][2]` | ELF symbols + DWARF layout |
| Inside a scalar or padding | `&rxBuf+0x3`, `&g_square.w+0x2` | ELF symbols |
| Function | `clickHandler()`, or `name+0x4` inside it (Thumb bit cleared) | ELF symbols |
| Virtual table pointer | dynamic class name | ELF symbols / runtime graph |
| `char *` into read-only data | `"hello"` (up to 64 bytes, escaped) | ELF file |
| Peripheral register | `&GPIOA->ODR` | bound SVD |
| Flash, RAM, Peripheral, System without a symbol | `0x20001234` (region in the tooltip) | ELF sections |
| Outside every known region | `0x12345678` in the warning color | — |
| Zero | `NULL` | — |

Member paths stop at the outermost object starting at the address; unions and bitfields end the
path with a byte offset. When the target's layout is not loaded yet the host requests it once and
the next sample shows the member path. Namespaces are omitted in the cell (`&lab::g_widgets[1]` is shown as `&g_widgets[1]`); the
tooltip keeps the qualified name. String text is read from the ELF file's allocated,
read-only `PROGBITS` sections only, whose bytes equal the target's and never change; it is
not used when the ELF file changed after it was parsed. Strings in RAM are shown by
expanding the pointer. Peripheral names come from the SVD bound to the workspace and are
loaded once per binding when sampling is configured.

The host annotates pointer values from the ELF symbol table without reading the target and
attaches `pointerText` (for example `→ &rxBuf[12]`), the machine-readable `pointerInfo`
(`kind`: `data`, `function`, `vtable`, `peripheral`, `region` or `invalid`; data targets may add
`memberPath` and the remaining `memberOffset`) and, for C
strings, `pointerString`. Annotations are cached per ELF (SHA-256) in a bounded LRU and
refreshed when symbol metadata changes. They are display hints only and never grant read or
write authority.

## Expanding a pointer

A data pointer row starts with a disclosure arrow, for members as well as pointer variables
watched on their own (their type graph is loaded when the row first appears). Expanding it shows the pointed-to object
directly below the row, the way debuggers such as Ozone expand pointers in their watch
tables; it is not added as another watch card. Expanding adds a read-only watch named
`<path>.value`, so the target is only read while it is expanded; collapsing removes that
watch together with everything expanded below it. The same paths can be entered directly:
`owner.value`, `owner->field` or `owner.value.field`. A saved `<path>.value` whose pointer
row is not visible (for example when only the target was watched) is shown as its own card.

- Only one level is followed per request. Pointers inside the target show their own arrow.
- `void *`, function pointers and pointers to declaration-only types cannot be expanded.
- The target type is the pointer's static type.
- Each sample re-reads the pointer, so the target follows the pointer as it changes. While
  the pointer is `NULL` the arrow and the target are hidden.
- A scalar target is one row (`*name`). In Live Watch it is a chart series that starts hidden.
- A dereferenced `char` shows a string preview of up to 32 bytes, escaped, ending at the
  first NUL or at the end of the verified memory range (truncation is marked with `…`).
- Reads use the runtime reader limits: addresses must lie in verified allocated ELF ranges
  (MMIO targets are rejected before any read), and each cycle is bounded to 4096 bytes,
  32 reads and a time budget. A null or unreadable target is reported as unavailable.
- Dereferenced targets are never write destinations, in the UI or through the Agent Bridge.

Pointers that the runtime reader already followed inside STL objects nest their target under
the pointer row in the same way, collapsed by default, without adding a watch.

Inside STL containers, pointers that cannot be followed (opaque targets, cycles, budget
exhaustion, unreadable memory) become local address rows with a reason instead of failing
the whole variable.

## Reopening the view

Saved lists keep only identities, so a reopened view lays the rows out from the ELF type graph
before any sample: pointer rows of runtime composites exist as value-less placeholder rows, and
the `<path>.value` watches saved below them nest in those rows instead of appearing as separate
cards. Placeholder rows cannot be charted until a sample supplies their address.

The last sampled target of every pointer is kept with the view state (at most 512 entries,
cleared when the ELF changes or the variable is removed). Until sampling starts the pointer cell
shows it dimmed and in italics, and its tooltip ends with "last sampled". It is a display hint
only; the target is never read without sampling.

Pointer variables added to the sampling list start with their chart curve hidden, since the
address rarely carries information. Switching the swatch on is remembered. The chart panel also
names pointer targets when the host keeps the chart history (`chartValues` samples carry the
same pointer annotations as `liveSample`).

## Agent Bridge

Decoded trees keep every raw member. Members carry `memberRole` (`artificial` or
`internal`) when the UI hides them by default, library objects carry `stdSummary`, and
pointer leaves carry `isPointer`, `pointerTarget`, a hexadecimal `valueText` and, when
available, `pointerText` / `pointerInfo` / `pointerString`.

## Validation

`node test/member-roles.test.js`, `node test/pointer-display.test.js`,
`node test/pointer-symbolizer.test.js`, `node test/pointer-deref.test.js` and
`node test/runtime-pointer-fallback.test.js` use a GCC 15.2 ARM fixture
(`test/fixtures/pointer-classes/`, regenerate with `node scripts/build-pointer-fixture.js`)
for DWARF 4 and 5. `node test/pointer-targets.test.js` covers target labels, strings,
peripherals and in-place expansion with `test/fixtures/pointer-targets/` (regenerate with
`node scripts/build-pointer-fixture.js pointer-targets`). These tests do not establish board
support. The built-in GDB debugger's variable view is unchanged.
