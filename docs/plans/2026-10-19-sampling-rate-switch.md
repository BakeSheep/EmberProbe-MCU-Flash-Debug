# Sampling rate switching

Switching an active graph from unlimited to a finite rate currently rebuilds the read plan, discards measured probe costs, and restarts the 100 ms warm-up. Other finite rate switches retain the previous graph's three-second frequency history; changes above the sidebar interval can also leave the old timer armed.

Keep calibration and cached sidebar values when both consumer read lists are unchanged. Reset graph measurement ticks on rate changes, invalidate in-flight cycles, and immediately rearm the scheduler even when the combined base interval remains unchanged. Retain P95 safety margins and full warm-up after variable changes or sampling restarts. Apply runtime settings before awaiting configuration persistence.

Verify unlimited-to-finite transitions, both directions between presets, low frequencies sharing the sidebar clock, in-flight reads, unchanged rates, and slow-probe safety with deterministic tests and the fake OpenOCD server. Run normal checks, quality gates, bundling, and Extension Host tests. No physical hardware operations are needed.
