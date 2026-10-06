# Reference workbench appearance

Match the user's real screenshot, excluding all other installed extensions' icons and status text. Retain the EmberProbe demo project, variables and simulation; do not copy the screenshot's project files or readings.

- Compact 35px title bar with location navigation, project command box and native layout controls. Hide classic menu/window chrome for this screenshot layout.
- 44px activity buttons, a 320px primary sidebar, rounded workbench containers, a full-height waveform editor and native active tab treatment. Preserve editor navigation, resizers, debugging, theme propagation and frame lifetimes.
- Measure the supplied PNG's light backgrounds (#fafafd), tab strip (#ebebeb) and activity selection (#d6d6d6). Apply overrides only in the demo, after its real extension CSS; keep the extension renderers unchanged.
- Default to the waveform tab, collapsed MCU/chip configuration and terminal, and an expanded RTOS section. Debugging remains available through F5 and its existing controls; simulated sampling starts on request.
- Verify navigation and layout changes without remounting the waveform, focused regressions, the generated demo, browser screenshots at the reference's approximate CSS display scale and a short viewport, then the repository's check/quality/bundle/E2E commands. Leave work uncommitted.
