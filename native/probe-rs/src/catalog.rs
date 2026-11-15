use anyhow::{Result, ensure};
use probe_rs::config::Registry;
use serde_json::{Value, json};
use std::{fs::File, io::Read};

// Registry enumeration has no probe discovery or target connection side effects.
pub fn list(descriptions: &[String]) -> Result<Value> {
    ensure!(descriptions.len() <= 2, "Target description count budget");
    let mut registry = Registry::from_builtin_families();
    for description in descriptions {
        let file = File::open(description)?;
        ensure!(file.metadata()?.is_file(), "Expected target YAML file");
        let mut yaml = Vec::new();
        file.take(4 * 1024 * 1024 + 1).read_to_end(&mut yaml)?;
        ensure!(yaml.len() <= 4 * 1024 * 1024, "Target YAML byte budget");
        registry.add_target_family_from_yaml(std::str::from_utf8(&yaml)?)?;
    }
    let mut chips = Vec::new();
    for family in registry.families() {
        for chip in &family.variants {
            if chip.cores.len() == 1 && chip.cores[0].core_type.is_cortex_m() {
                ensure!(
                    family.name.len() <= 256 && chip.name.len() <= 128,
                    "Chip metadata byte budget"
                );
                chips.push(json!({"name": chip.name, "family": family.name,
                    "core": chip.cores[0].core_type}));
            }
        }
    }
    chips.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    chips.dedup_by(|a, b| a["name"] == b["name"]);
    ensure!(chips.len() <= 30000, "Chip catalog count budget");
    Ok(json!({"protocol": 1, "chips": chips}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_only_contains_single_cortex_m_targets() {
        let result = list(&[]).unwrap();
        let chips = result["chips"].as_array().unwrap();
        assert!(chips.len() > 100);
        assert!(
            chips
                .iter()
                .any(|chip| chip["name"].as_str().unwrap().starts_with("STM32F4"))
        );
        assert!(
            !chips
                .iter()
                .any(|chip| chip["core"] == "riscv" || chip["name"] == "RP2040")
        );
        assert!(list(&vec!["unused".to_string(); 3]).is_err());
    }
}
