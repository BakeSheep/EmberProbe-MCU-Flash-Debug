# Third-Party Notices

The bundled extension includes the following npm runtime packages:

- `tar` 7.5.20, `chownr` 3.0.0, `minipass` 7.1.3, and `yallist` 5.0.0 — [Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)
- `@isaacs/fs-minipass` 4.0.1 — ISC License, Copyright (c) Isaac Z. Schlueter and Contributors
- `minizlib` 3.1.0 — MIT License, Copyright (c) 2017-2023 Isaac Z. Schlueter and Contributors; Node.js contributors; Joyent, Inc. and other Node contributors
- `fast-xml-parser` 5.11.0 and its runtime dependencies (`@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum`, `anynum`, and `xml-naming`) — MIT License
- `yauzl` 3.4.0 and `pend` 1.2.0 — MIT License
- `koffi` 3.3.1 and `@koromix/koffi-win32-x64` 3.3.1 — MIT License, Copyright (c) 2026 Niels Martignène; their license files are retained in the packaged dependencies.

The MCP server (`dist/mcp-server.js`) bundles:

- `@modelcontextprotocol/sdk` 1.32.1 — MIT License, Copyright (c) 2024 Anthropic, PBC
- `zod` 4.6.7 — MIT License, Copyright (c) 2025 Colin McDonnell
- `ajv` 8.20.0 — MIT License, Copyright (c) 2015-2017 Evgeny Poberezkin; `ajv-formats` 3.0.1, `fast-deep-equal` 3.1.3 and `json-schema-traverse` 1.0.0 — MIT License
- `zod-to-json-schema` 3.25.2 — ISC License, Copyright (c) 2020, Stefan Terdell
- `fast-uri` 3.1.9 — BSD 3-Clause License, reproduced below

The extension contains Windows x64 and Linux x64 EmberProbe-modified OpenOCD builds based on xPack 0.12.0-7 (upstream revision e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3), with the GPL-2.0-or-later patches in native/openocd/: the EmberProbe scatter patch, STMicroelectronics' `stldr` flash driver and `stm32c5x.cfg` from pending upstream reviews 9697 and 9699, and an EmberProbe change selecting bundled flash loaders. These are not official xPack binaries. Complete component license sets remain inside both runtime archives under distro-info/licenses/. The matching emberprobe-openocd-source.tar.gz is provided beside the VSIX in the same GitHub Release and includes the actual OpenOCD/submodule sources, dependency source inputs and build recipes. The resource manifest pins the runtime, patch, build and corresponding-source identities. See native/openocd/README.md for build and source instructions.

The Windows driver helper dynamically loads libwdi 1.5.1 (GNU LGPL v3 or later). The exact upstream revision is `9b23b82a2dd1cbffc16d46c212f92c6bf8c0c602`. Its source is vendored in `native/vendor/libwdi/` (with unused sample applications, upstream CI workflows, and release scripts removed); EmberProbe generates `msvc/config.h` from `msvc/config.h.in` to embed only WinUSB support and use a local WDK redistributable path. The LGPL and accompanying GPL terms are in `native/vendor/libwdi/COPYING-LGPL` and `native/vendor/libwdi/COPYING`. The dedicated EmberProbe helper source is in `native/driver-helper/` and remains under EmberProbe's MIT license. To use a modified libwdi, rebuild the DLL and helper from these sources; the helper's generated `libwdi_hash.h` pins the chosen DLL bytes for elevated loading. `scripts/build-driver-helper.ps1` and `scripts/sign-driver-helper.ps1` document the build and signing sequence, and may be run with your own signing certificate.

The xPack archives additionally contain six EmberProbe compatibility wrappers under GPL-2.0-or-later. They source the original OpenOCD target scripts without adding flash drivers. Reviewable wrapper sources are in `resources/openocd-targets/target/`; `resources/openocd-targets-manifest.json` and the archived `distro-info/emberprobe-targets.json` record canonical script URLs, reviewed build/source identities and wrapper hashes. See `docs/OPENOCD-TARGETS.md` for the mappings and rebuild procedure.

Both OpenOCD archives also contain three STM32C5 flash loaders (`openocd/scripts/flash_loaders/stm32c5/*.xldr`), Copyright STMicroelectronics, distributed unmodified under the BSD 3-Clause License from the `stm32c5xx-dfp` repository (tag 2.1.0, commit `a5f65bc64535cfa723e9d25f58d7ce23d0937aed`). Only the file names were changed to drop shell-glob brackets. The upstream license text accompanies them as `LICENSE.html`; reviewable copies and source URLs are in `resources/openocd-targets/flash_loaders/stm32c5/` and `resources/openocd-targets-manifest.json`.

## ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## MIT License (`minizlib`, `fast-xml-parser`, `yauzl`, and listed dependencies)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## BSD 3-Clause License (`fast-uri`)

Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
- The names of any contributors may not be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Independent debugger

`@vscode/debugadapter` 1.68.0 and `@vscode/debugprotocol` — MIT, Copyright Microsoft Corporation.

The MI C-string decoder is adapted from Cortex-Debug `src/backend/mi_parse.ts`; the MI command flow references `src/backend/mi2/mi2.ts` and `src/gdb.ts`. Reference: Cortex-Debug 1.13.0-pre10, commit `d8b7f6cb1e87ab47792a06f043bc7fa395f856b4`. No upstream extension runtime is included.

Copyright 2017-2023 Marcel Ball

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
