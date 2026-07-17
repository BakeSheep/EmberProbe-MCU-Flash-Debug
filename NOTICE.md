# Attribution

EmberProbe is derived from the publicly distributed `yingwudao.mcu-vscode` extension version 0.0.2.

The original extension was published on the Visual Studio Marketplace with an MIT license declaration and listed this source repository:

- Marketplace: https://marketplace.visualstudio.com/items?itemName=yingwudao.mcu-vscode
- Original repository: https://github.com/yingwudao/mcu-vscode

The original repository was unavailable when this derivative was prepared. The maintainable JavaScript sources in this repository were reconstructed from the publicly distributed VSIX, then substantially modified with a new UI, branding, automatic configuration detection, structured OpenOCD output, and an Agent Skill.

## Real-time Variable Viewer

The Live Variable Viewer feature (实时变量查看) is an independent, clean-room implementation inspired by the concept of the MCUViewer project's Variable Viewer (https://github.com/klonyyy/MCUViewer). MCUViewer is licensed under GPLv3 and is now closed-source; no MCUViewer source code was copied or adapted. EmberProbe implements live RAM sampling on its own via OpenOCD's Tcl-RPC interface and a self-written ELF symbol parser. EmberProbe is not affiliated with or endorsed by the MCUViewer project.
