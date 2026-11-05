# Live Sampling and History

[中文](sampling.md)

EmberProbe keeps reading RAM variables while the target runs and shows the values in the sidebar and waveform panels. **Start** samples everything you are watching; clicking it again stops all of it.

## Sampling frequency

| Where a variable is watched | Target frequency | Keeps history |
| --- | --- | --- |
| Waveform panel, including hidden curves | 0.1–200 Hz, 30 Hz by default, or Max rate | Yes |
| Sidebar or write list only | Fixed 20 Hz | No, current value only |

Enter a frequency in the waveform toolbar, or use the slider in the input's dropdown to pick 20, 50, 100, or 200 Hz. `emberprobe.sampleFrequencyHz` sets the default.

The actual frequency depends on probe throughput, the number of variables, and how their addresses are spread, so it can be lower than the target. Sampling takes a smaller share of the probe during debug sessions, and values refresh about every 250 ms while the target is paused.

To reach a higher actual frequency:

- Watch fewer variables, or variables at adjacent addresses.
- Raise the sampling clock with `emberprobe.samplingAdapterSpeedKhz`.
- Use the bundled OpenOCD by leaving `emberprobe.openocdPath` at its default, `openocd` (Windows and Linux x64).

## Max rate

Drag the slider to its right end to select **Max rate**. The input shows `-` and the toolbar shows the actual frequency. Each read round starts as soon as the previous one ends, so the probe sets the pace. Pick a frequency or enter a number to leave Max rate. The choice is saved per workspace.

Before using it:

- It applies to standalone sampling only. Debug sessions use the most recent finite frequency, and the input's tooltip explains why.
- Sidebar variables stay at 20 Hz.
- High rates use up memory and the disk archive faster.
- Agents cannot enable Max rate. They can only set a finite sampling interval.

## Hidden curves and members

Hiding a curve only affects drawing: the variable keeps being sampled and recorded. When you show it again, the history from the hidden period is there.

When you add a composite such as a static struct to a waveform panel, its scalar members start recording immediately. If you enable a member's curve later, you see its history from when the parent started sampling.

Removing a variable stops sampling it, but data already recorded can still be exported.

## Viewing history

The timeline and the All window cover the whole session since sampling started or history was last cleared. Recent data comes from memory and older data from disk, with no switching on your part. Older ranges can briefly appear as a coarser overview while you zoom in.

- **Freeze Chart** holds the current history for inspection while sampling and current values continue. Variables added while frozen appear after you resume live.
- **Clear History** clears the current panel's current session only. Other panels are unaffected.
- Changing a variable's watch type restarts that curve's live history.

## Exporting CSV

Click **Export CSV** and choose variables and a time range. By default it exports every original sample of the selected variables since sampling started or history was last cleared, including history beyond the memory range and variables you have removed.

- Only waveform variables are exported. Sidebar-only variables are not written to the CSV.
- Freezing does not change the export range, and neither do number bases, normalization, or curve styles.
- Progress and Cancel appear in a VS Code notification, and the finished file can be revealed in its folder.
- If history is cleared or the session changes while the save dialog is open, the export is cancelled so that it cannot contain the wrong data.

## History capacity

| Setting | Default | Purpose |
| --- | --- | --- |
| `emberprobe.chartHistoryMaxMiB` | 512 MiB (64–4096) | Memory limit for recent history |
| `emberprobe.samplingArchiveMaxMiB` | 1024 MiB | Temporary disk archive limit |

Running out of memory budget only shortens what stays in memory. Older data still comes from disk and sampling continues.

**The disk archive is deleted when the extension exits.** Export a CSV to keep the data.

## Troubleshooting

**Sampling paused by itself.** The disk archive is full or a write failed. Export what you need, then clear history, raise `emberprobe.samplingArchiveMaxMiB`, or check free disk space.

**The actual frequency is far below the target.** This is usually the limit of the probe or SWD clock, especially on wireless and HID probes. See the suggestions above.

**The toolbar says the extension host is the limit.** VS Code is busy with other heavy work, such as another extension's configuration or parsing. Sampling recovers when that work ends.

**Max rate has no effect while debugging.** This is expected. Max rate applies to standalone sampling only.

**The chart says history is incomplete.** That range exists neither in memory nor on disk, usually because of a disk write failure or a full archive.

## Related documents

- [Waveform panels](waveform.en.md)
- [Settings](../settings.en.md)
- [Sampling pipeline design](../../design/sampling-pipeline.md)
- [Chart history design](../../design/chart-history.md)
