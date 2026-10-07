# Direct enum variable display

Read enum members and exact constants from DWARF and preserve them through aliases,
composite layouts and runtime graphs. Use the same enum resolver for static and runtime
scalar widths. DWARF supplies qualified names for C++ scoped enums and namespaces;
C enum members retain their source names.

Keep `value` and `valueText` numeric for charting, export and write inputs. Add a separate
`enumText` presentation field, rendered as text in sidebar and Live Watch value cells.
Replace the complete qualified prefix with a leading dot, for example `.Active(3)`;
keep full names in the enum metadata and use `ACTIVE(3)` for unqualified members.
Show all matching aliases and retain numeric display for unknown values. Plain integer
variables assigned enum constants retain their integer type and are not guessed.

Legacy DWARF without an encoding uses complete enumerator values to determine a read
interpretation: negative constants imply signed reads, otherwise use raw unsigned reads.
Inferred encoding remains read-only, including composite leaves. Missing enum metadata
does not silently guess an unsigned encoding. Existing authorization and memory budgets
remain in place; enum tables are bounded to 1024 entries and 64 KiB of names/constants.

Verify ordinary/scoped enums, qualifiers and aliases, composite and bitfield leaves,
runtime pointers, exact 64-bit constants, malformed inputs, duplicate values and safe UI
rendering. Compile ARM C/C++ DWARF 2/4/5 fixtures without executing or flashing firmware,
then run repository checks, quality, bundle and Extension Host tests.
