// SEGGER uses a decimal J-Link serial; USB descriptors may pad it with leading zeroes.
// Other probes have opaque serial strings and must continue to match byte for byte.
pub fn matches(
    expected_vendor: u16,
    expected_product: u16,
    expected_serial: &str,
    vendor: u16,
    product: u16,
    serial: Option<&str>,
) -> bool {
    if vendor != expected_vendor || product != expected_product {
        return false;
    }
    let Some(serial) = serial else { return false };
    if serial == expected_serial {
        return true;
    }
    if vendor != 0x1366 {
        return false;
    }
    fn decimal(value: &str) -> Option<u32> {
        if value.is_empty() || value.len() > 256 || !value.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        value.parse::<u32>().ok().filter(|value| *value > 0)
    }
    match (decimal(expected_serial), decimal(serial)) {
        (Some(expected), Some(actual)) => expected == actual,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jlink_decimal_serial_accepts_usb_zero_padding_in_either_direction() {
        assert!(matches(
            0x1366,
            0x0101,
            "20781318",
            0x1366,
            0x0101,
            Some("000020781318")
        ));
        assert!(matches(
            0x1366,
            0x0101,
            "000020781318",
            0x1366,
            0x0101,
            Some("20781318")
        ));
        assert!(matches(
            0x1366,
            0x0101,
            "20781318",
            0x1366,
            0x0101,
            Some("20781318")
        ));
    }
    #[test]
    fn mismatched_missing_or_invalid_identity_never_falls_back_to_another_probe() {
        for (vendor, product, serial) in [
            (0x1366, 0x0101, Some("000020781319")),
            (0x1366, 0x0105, Some("000020781318")),
            (0x0483, 0x0101, Some("000020781318")),
            (0x1366, 0x0101, None),
            (0x1366, 0x0101, Some(" 20781318")),
            (0x1366, 0x0101, Some("4294967296")),
        ] {
            assert!(!matches(
                0x1366, 0x0101, "20781318", vendor, product, serial
            ));
        }
        assert!(!matches(0x1366, 0x0101, "0", 0x1366, 0x0101, Some("0000")));
        assert!(!matches(
            0x1a86,
            0x8012,
            "1234",
            0x1a86,
            0x8012,
            Some("001234")
        ));
        assert!(!matches(
            0x0483,
            0x3748,
            "1234",
            0x0483,
            0x3748,
            Some("001234")
        ));
    }
    #[test]
    fn duplicate_numeric_serials_remain_ambiguous() {
        let count = ["20781318", "000020781318"]
            .iter()
            .filter(|serial| matches(0x1366, 0x0101, "20781318", 0x1366, 0x0101, Some(serial)))
            .count();
        assert_eq!(count, 2);
    }
}
