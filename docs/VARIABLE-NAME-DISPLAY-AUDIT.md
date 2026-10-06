# Variable display-name audit

Normal ELF variable labels use the readable `displayName`, including namespace and member paths.
For example, `_ZL3pwr.data_.bus_voltage_v` is presented as `pwr.data_.bus_voltage_v`.
Curve hover labels retain the requested compact form `.bus_voltage_v`.

| Frontend surface | Presentation |
| --- | --- |
| Waveform cards, nested members and remove-button accessible labels | Readable names; nested members retain their local labels and expose readable full paths in tooltips |
| Curve hover and context menu | Compact readable leaf on hover, full readable name in the menu |
| Import list, member tooltips, autocomplete and array selection | Readable labels and tooltips; search accepts both readable and raw names |
| CSV series selection | Readable full names, including archived variables removed from the current watch list when ELF metadata remains available |
| Complete-history CSV | Provider resolves readable headers; archive reads values using the original symbol keys |
| Frozen-snapshot and retained-buffer CSV | Renderer supplies readable headers with the original per-series buffers |
| Sidebar watch/write cards, composite members and ELF variable browser | Shared readable-name resolver, including saved selections and member-search results |
| Memory-analysis symbol ranking | Readable text and tooltips |

The resolver prefers enriched ELF metadata. Placeholder metadata containing only the original name does not replace
readable labels cached in saved watch entries. Member paths inherit the readable root name. If no readable metadata or
cached label exists, the original name remains the fallback.

Original symbol names remain in sampling and write requests, archive records, selection/removal commands, series-style
keys, saved identities and DOM identity attributes. They are not appended to ordinary display-name tooltips.
The archive service's default header behavior remains unchanged for callers that do not request display labels,
including Agent CSV reads. Diagnostic messages and raw diagnostic payloads can still contain original symbol names.
SVD register/field names, RTOS session/task names and linker region/section names are separate naming domains and retain
their existing labels.

Focused regressions cover C++ nested paths, cached labels while ELF metadata loads, removed watches, normal UI tooltips,
all three frontend CSV sources, raw-key value lookup, column order, CSV escaping and formula protection. No full repository
check or hardware validation is required for this presentation change.
