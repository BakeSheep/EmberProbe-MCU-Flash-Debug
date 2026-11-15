use anyhow::{Context, Result, ensure};
use probe_rs::{Core, MemoryInterface};
use serde::{Deserialize, Serialize};
pub const MAX_BYTES: usize = 4096;
pub const MAX_RANGES: usize = 64;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub address: u64,
    pub count: usize,
}
pub struct Elf {
    pub bytes: Vec<u8>,
    pub ram: Vec<(u64, u64)>,
    pub flash: Vec<(u64, usize, usize)>,
}
fn word(data: &[u8], at: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        data.get(at..at + 4).context("Truncated ELF")?.try_into()?,
    ))
}
fn half(data: &[u8], at: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        data.get(at..at + 2).context("Truncated ELF")?.try_into()?,
    ))
}
pub fn parse_elf(bytes: Vec<u8>) -> Result<Elf> {
    ensure!(
        (52..=64 * 1024 * 1024).contains(&bytes.len()),
        "ELF byte budget"
    );
    ensure!(
        &bytes[..6] == b"\x7fELF\x01\x01" && half(&bytes, 18)? == 40,
        "Expected ARM ELF32 LE"
    );
    let sections = word(&bytes, 32)? as usize;
    let stride = half(&bytes, 46)? as usize;
    let count = half(&bytes, 48)? as usize;
    ensure!(
        stride >= 40 && count > 0 && count <= 16384 && sections + stride * count <= bytes.len(),
        "ELF section budget"
    );
    let mut ram = Vec::new();
    for index in 0..count {
        let at = sections + index * stride;
        let address = word(&bytes, at + 12)? as u64;
        let size = word(&bytes, at + 20)? as u64;
        let end = address + size;
        let conventional = (address >= 0x20000000 && end <= 0x40000000)
            || (address >= 0x10000000 && end <= 0x10080000);
        if word(&bytes, at + 8)? & 3 == 3 && size > 0 && conventional {
            ram.push((address, end));
        }
    }
    ensure!(!ram.is_empty(), "No writable allocated SRAM sections");
    let header = word(&bytes, 28)? as usize;
    let stride = half(&bytes, 42)? as usize;
    let count = half(&bytes, 44)? as usize;
    ensure!(
        stride >= 32 && count <= 1024 && header + stride * count <= bytes.len(),
        "ELF segment budget"
    );
    let mut flash = Vec::new();
    for index in 0..count {
        let at = header + index * stride;
        if word(&bytes, at)? != 1 {
            continue;
        }
        let offset = word(&bytes, at + 4)? as usize;
        let address = word(&bytes, at + 12)? as u64;
        let size = word(&bytes, at + 16)? as usize;
        ensure!(
            offset
                .checked_add(size)
                .is_some_and(|end| end <= bytes.len()),
            "Invalid ELF segment"
        );
        if size > 0 {
            flash.push((address, offset, size));
        }
    }
    Ok(Elf { bytes, ram, flash })
}
// The ELF alone cannot authorize reads: require the selected target's physical memory map too.
pub fn bind_regions(elf: &mut Elf, ram: &[(u64, u64)], flash: &[(u64, u64)]) -> Result<()> {
    elf.ram
        .retain(|(start, end)| ram.iter().any(|(a, b)| start >= a && end <= b));
    ensure!(
        !elf.ram.is_empty(),
        "ELF SRAM is outside the selected target"
    );
    elf.flash.retain(|(address, _, size)| {
        flash
            .iter()
            .any(|(a, b)| address >= a && address + *size as u64 <= *b)
    });
    let total: usize = elf.flash.iter().map(|(_, _, size)| size).sum();
    ensure!(
        total > 0 && total <= 16 * 1024 * 1024,
        "ELF Flash verification budget (1 byte..16 MiB)"
    );
    Ok(())
}
pub fn validate_ranges(ranges: &[Range], ram: &[(u64, u64)]) -> Result<usize> {
    ensure!(ranges.len() <= MAX_RANGES, "Range count budget exceeded");
    let mut total = 0usize;
    for range in ranges {
        ensure!(
            range.count > 0 && range.count <= MAX_BYTES,
            "Read byte budget"
        );
        let end = range
            .address
            .checked_add(range.count as u64)
            .context("Address overflow")?;
        ensure!(
            ram.iter()
                .any(|(start, stop)| range.address >= *start && end <= *stop),
            "LIVE_ADDRESS_NOT_RAM"
        );
        total += range.count;
        ensure!(total <= MAX_BYTES, "Per-cycle byte budget exceeded");
    }
    Ok(total)
}
// Never widen ranges. Naturally aligned words use the library's widest read interface.
pub fn read(core: &mut Core<'_>, range: &Range, output: &mut [u8]) -> Result<()> {
    ensure!(output.len() == range.count, "Read output shape mismatch");
    if range.address % 4 == 0 && range.count % 4 == 0 {
        let mut words = [0u32; MAX_BYTES / 4];
        core.read_32(range.address, &mut words[..range.count / 4])?;
        for (word, bytes) in words.iter().zip(output.chunks_exact_mut(4)) {
            bytes.copy_from_slice(&word.to_le_bytes());
        }
    } else if range.address % 2 == 0 && range.count % 2 == 0 {
        let mut words = [0u16; MAX_BYTES / 2];
        core.read_16(range.address, &mut words[..range.count / 2])?;
        for (word, bytes) in words.iter().zip(output.chunks_exact_mut(2)) {
            bytes.copy_from_slice(&word.to_le_bytes());
        }
    } else {
        core.read_8(range.address, output)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_map_binds_ram_and_flash_including_zero_based_flash() {
        let mut elf = Elf {
            bytes: vec![],
            ram: vec![(0x20000000, 0x20000004), (0x30000000, 0x30000004)],
            flash: vec![(0, 0, 4), (0x40000000, 0, 4)],
        };
        assert!(bind_regions(&mut elf, &[(0x20000000, 0x20001000)], &[(0, 1024)]).is_ok());
        assert_eq!(elf.ram, vec![(0x20000000, 0x20000004)]);
        assert_eq!(elf.flash, vec![(0, 0, 4)]);
        assert!(bind_regions(&mut elf, &[(0x20000000, 0x20001000)], &[]).is_err());
    }
    #[test]
    fn bounded_sram_only() {
        let ram = [(0x20000000, 0x20010000)];
        assert!(
            validate_ranges(
                &[Range {
                    address: 0x20000001,
                    count: 3
                }],
                &ram
            )
            .is_ok()
        );
        assert!(
            validate_ranges(
                &[Range {
                    address: 0x40000000,
                    count: 4
                }],
                &ram
            )
            .is_err()
        );
        assert!(
            validate_ranges(
                &[Range {
                    address: u64::MAX,
                    count: 4
                }],
                &ram
            )
            .is_err()
        );
        assert!(
            validate_ranges(
                &[
                    Range {
                        address: 0x20000000,
                        count: 4096
                    },
                    Range {
                        address: 0x20001000,
                        count: 4
                    }
                ],
                &ram
            )
            .is_err()
        );
        assert!(parse_elf(Vec::new()).is_err());
    }
}
