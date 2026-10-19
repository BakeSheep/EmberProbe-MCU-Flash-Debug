# ELF diagnostic language

Keep the existing diagnostic panels and delivery timing. Translate diagnostic content when rendering it, using each webview's selected language so cached messages change immediately with the language toggle.

- Preserve raw parser messages and machine-readable codes for Agent/API consumers.
- Use a shared browser/CommonJS formatter for known ELF/DWARF messages, reasons and diagnostic codes. Keep paths, section names, numbers and variable names as parameters, never executable markup.
- Carry translation keys and parameters for host-generated C++ binding diagnostics; do not cache the selected-language text as the only representation.
- Unknown third-party messages remain available verbatim; known diagnostic codes receive a translated explanation even if the low-level cause is unfamiliar.
- Verify both panels, waveform import diagnostics, live language changes, deduplication/escaping, raw-message compatibility, and the real H750 depth-limit warning. Run focused tests and repository check/quality/bundle/E2E validation.
