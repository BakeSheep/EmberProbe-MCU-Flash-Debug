`rust-globals.elf` is a small ARM ELF fixture with Rust 2024 DWARF and mangled
global symbols. Regenerate it with an installed `thumbv7em-none-eabihf` target:

```sh
rustc --crate-name rust_globals --target thumbv7em-none-eabihf --edition=2024 \
  -C debuginfo=2 -C opt-level=1 -C panic=abort \
  -C link-arg=-Ttest/fixtures/rust-globals.ld -C link-arg=-eReset \
  -C link-arg=--no-gc-sections \
  test/fixtures/rust-globals.rs -o test/fixtures/rust-globals.elf
```

The linker script places both globals in writable target RAM. Tests use the
checked-in ELF and therefore do not require Rust in CI.
