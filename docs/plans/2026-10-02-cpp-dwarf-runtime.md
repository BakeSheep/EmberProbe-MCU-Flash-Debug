# C++ DWARF and Runtime Sampling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correctly load supported external/type-unit/64-bit DWARF and sample C++ dynamic storage without guessing types or retaining stale addresses.

**Architecture:** Extend the existing bounded DWARF parser and file worker with section identities, type signatures and explicit companion-file loading. Generate bounded runtime type recipes from DWARF, then resolve dynamic addresses inside the sampling worker using the existing read queue, target memory ranges and epoch guards. Preserve all existing write authorization rules; dynamic sampling is read-only.

**Tech Stack:** ES2022 CommonJS, ELF32 Cortex-M, DWARF4/5, OpenOCD Tcl, Node assert tests and real ARM GCC/GDB fixtures.

---

### Task 1: DWARF formats and identity

- Modify `src/dwarf/{binary,forms,parser,types}.js` and `src/dwarf.js` for DWARF64 offsets, DWARF4/5 type units, signature references and split-unit identities.
- Keep section/file identities independent; enforce shared byte/DIE/abbreviation budgets.
- Load bounded `.dwo` companions relative to the ELF/source compilation directory and verify DWO identity before merging. Surface missing, mismatched and malformed companions.
- Add native-generated fixtures and hardware-independent assertions for normal, type-unit, DWARF64 and split variants, including partial failures.

### Task 2: Type-loss handling

- Update `src/elfWorker.js` and `src/services/elfService.js` so failed or incomplete DWARF cannot silently turn an unresolved object into an integer.
- Preserve explicitly typed reads and the existing no-DWARF compatibility where provenance is known. Never grant writes based on size alone.
- Test worker and synchronous paths, mixed compilation units and stale-file handling.

### Task 3: Runtime recipes and reads

- Generate typed, bounded recipes for references/pointers, fixed and virtual class members and supported libstdc++ storage.
- Resolve pointer chains and container element addresses on every sample. Verify descriptors after reads; reject mutation, null/cyclic pointers, invalid layouts and unreadable ranges with structured diagnostics.
- Integrate recipes into watch normalization, worker read plans, sidebar trees and scalar graph paths. All dynamic reads remain within validated target ranges and the existing command/byte/time budgets.
- Test resize/reallocation, virtual offsets, references, nested objects, malformed layouts, out-of-range pointers, cancellation and write isolation.

### Task 4: Verification and documentation

- Run focused tests, `npm run check`, `npm run quality`, `npm run bundle` and relevant extension-host tests.
- Run real GCC/GDB format and runtime-memory fixtures without hardware.
- Document supported formats, runtime paths, budgets, diagnostic behavior and exact verification scope in both READMEs and CHANGELOG.
