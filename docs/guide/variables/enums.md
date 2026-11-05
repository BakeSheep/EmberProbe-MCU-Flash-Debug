# Enum variables

With an ELF containing DWARF debug information, EmberProbe automatically reads C/C++
enum types and their member values. Sidebar and Live Watch value cells show, for example,
`ERROR(-1)` or `.Active(3)` for `app::State::Active`. Qualified member names replace the
entire `::` prefix with a leading dot; full names remain in the DWARF metadata.
This includes typedef/using aliases, const/volatile
types, struct/class/union members, arrays and supported runtime object reads. Existing
runtime path and RAM validation still determine which objects can be observed.

Multiple members with the same value are shown together, for example `ACTIVE / READY(3)`
or `.Active / .Ready(3)`.
Values absent from the enum table remain numeric. Plain `int value = ACTIVE` variables
remain integers: debug type information does not identify the initializer as an enum type.
No source parsing or GDB expression evaluation is required for live enum name display.

Charts and CSV keep numeric values. Exact 64-bit decimal text is preserved separately from
the enum label. Write inputs continue to accept numeric values under the existing write
authorization; enum member names are display labels, not new write commands.

For legacy DWARF that omits an underlying encoding, negative enumerators enable signed
reads; otherwise the storage is read as unsigned raw values. These inferred types remain
read-only. An enum without enough information to select a read encoding is unavailable
instead of silently using an unsigned type. Enum tables exceeding 1024 members or 64 KiB
of names and constant text are rejected by the DWARF budget.

Software validation: `node test/enum-variables.test.js` covers decoding and both webviews.
`node test/gdb/enum-variables.test.js` uses `arm-none-eabi-gcc` and `arm-none-eabi-g++`
(or `IMAGE_CC`/`IMAGE_CXX`) for ARM ELF fixtures. These tests do not establish board support.
