use crate::clock::{Clock, SystemClock};
use crate::{
    memory::{self, Elf, Range},
    protocol::{self, Batch, Request},
};
use anyhow::{Context, Result, bail, ensure};
use probe_rs::{
    Core, CoreStatus, Permissions,
    config::Registry,
    probe::{WireProtocol, list::Lister},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError},
    time::Duration,
};

fn bounded_file(path: &str, limit: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected a regular file");
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "Input file exceeds its byte budget");
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Init {
    chip: String,
    elf: String,
    elf_sha256: String,
    target_description: Option<String>,
    vendor_id: u16,
    product_id: u16,
    serial: String,
    speed_khz: u32,
    protocol: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    generation: u32,
    recipes: Vec<Vec<Range>>,
    graph: bool,
    sidebar: bool,
    graph_interval_ms: f64,
    unlimited: bool,
    enabled: bool,
}
impl Plan {
    fn validate(&self, elf: &Elf) -> Result<()> {
        ensure!(
            self.generation > 0 && self.recipes.len() == 4,
            "Invalid plan generation/recipes"
        );
        ensure!(
            self.graph_interval_ms.is_finite() && (5.0..=10000.0).contains(&self.graph_interval_ms),
            "Invalid interval"
        );
        for recipe in &self.recipes {
            memory::validate_ranges(recipe, &elf.ram)?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct Schedule {
    graph: f64,
    sidebar: f64,
}
impl Schedule {
    fn due(&mut self, plan: &Plan, now: f64) -> u8 {
        let graph = plan.graph && (plan.unlimited || now >= self.graph);
        let sidebar = plan.sidebar && now >= self.sidebar;
        if graph {
            self.graph = now + plan.graph_interval_ms;
        }
        if sidebar {
            self.sidebar = now + 50.0;
        }
        u8::from(graph) | (u8::from(sidebar) << 1)
    }
    fn delay(&self, plan: &Plan, now: f64) -> Duration {
        let next = if plan.graph && plan.unlimited {
            now
        } else {
            (if plan.graph {
                self.graph
            } else {
                f64::INFINITY
            })
            .min(if plan.sidebar {
                self.sidebar
            } else {
                f64::INFINITY
            })
        };
        Duration::from_secs_f64(((next - now).max(0.0) / 1000.0).min(0.01))
    }
}
fn reply(tx: &SyncSender<Vec<u8>>, id: u32, result: Result<Value>) -> Result<()> {
    let body = match result {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(error) => {
            json!({"id": id, "ok": false, "error": {"code": "PROBE_RS_REQUEST_FAILED", "message": format!("{error:#}")}})
        }
    };
    tx.send(protocol::control(&body)).context("Output closed")
}
fn verify_flash(core: &mut Core<'_>, elf: &Elf) -> Result<usize> {
    let mut compared = 0usize;
    for &(address, offset, count) in &elf.flash {
        for (index, expected) in elf.bytes[offset..offset + count].chunks(4096).enumerate() {
            let mut actual = [0u8; 4096];
            memory::read(
                core,
                &Range {
                    address: address + (index * 4096) as u64,
                    count: expected.len(),
                },
                &mut actual[..expected.len()],
            )?;
            compare_flash_chunk(
                address + (index * 4096) as u64,
                expected,
                &actual[..expected.len()],
            )?;
            compared += expected.len();
        }
    }
    Ok(compared)
}
fn compare_flash_chunk(address: u64, expected: &[u8], actual: &[u8]) -> Result<()> {
    ensure!(
        expected.len() == actual.len(),
        "Invalid Flash comparison shape"
    );
    if let Some(index) = expected.iter().zip(actual).position(|(a, b)| a != b) {
        let end = (index + 16).min(expected.len());
        bail!(
            "DEBUG_ELF_SESSION_MISMATCH: Flash differs at 0x{:08x}; ELF {:02x?}, target {:02x?}",
            address + index as u64,
            &expected[index..end],
            &actual[index..end]
        );
    }
    Ok(())
}
fn read_ranges(core: &mut Core<'_>, ranges: &[Range]) -> Result<Vec<u8>> {
    let mut data = vec![0; ranges.iter().map(|range| range.count).sum()];
    let mut offset = 0;
    for range in ranges {
        memory::read(core, range, &mut data[offset..offset + range.count])?;
        offset += range.count;
    }
    Ok(data)
}

pub fn run(rx: Receiver<Result<Request>>, tx: SyncSender<Vec<u8>>) -> Result<()> {
    run_with_clock(rx, tx, SystemClock::new())
}
fn run_with_clock(
    rx: Receiver<Result<Request>>,
    tx: SyncSender<Vec<u8>>,
    clock: impl Clock,
) -> Result<()> {
    let first = rx.recv().context("Input closed before initialization")??;
    ensure!(
        first.method == "start",
        "First request must initialize the session"
    );
    let initialized = (|| -> Result<_> {
        let init: Init = serde_json::from_value(first.params.clone())?;
        ensure!(
            !init.serial.is_empty() && init.serial.len() <= 256 && !init.chip.is_empty(),
            "Exact chip and probe serial required"
        );
        ensure!(
            init.speed_khz > 0 && init.speed_khz <= 50000,
            "Invalid SWD/JTAG speed"
        );
        let mut elf = memory::parse_elf(bounded_file(&init.elf, 64 * 1024 * 1024)?)?;
        let digest = format!("{:x}", Sha256::digest(&elf.bytes));
        ensure!(digest == init.elf_sha256, "ELF changed during startup");
        let mut registry = Registry::from_builtin_families();
        if let Some(description) = &init.target_description {
            let yaml = bounded_file(description, 4 * 1024 * 1024)?;
            registry.add_target_family_from_yaml(std::str::from_utf8(&yaml)?)?;
        }
        let target = registry.get_target_by_name(&init.chip)?;
        let ram: Vec<_> = target
            .memory_map
            .iter()
            .filter_map(|region| {
                region
                    .as_ram_region()
                    .map(|ram| (ram.range.start, ram.range.end))
            })
            .collect();
        let flash: Vec<_> = target
            .memory_map
            .iter()
            .filter_map(|region| {
                region
                    .as_nvm_region()
                    .map(|nvm| (nvm.range.start, nvm.range.end))
            })
            .collect();
        memory::bind_regions(&mut elf, &ram, &flash)?;
        ensure!(
            target.cores.len() == 1,
            "Native sampling requires one target core"
        );
        let infos = Lister::new().list_all();
        let matched: Vec<_> = infos
            .iter()
            .filter(|info| {
                crate::identity::matches(
                    init.vendor_id,
                    init.product_id,
                    &init.serial,
                    info.vendor_id,
                    info.product_id,
                    info.serial_number.as_deref(),
                )
            })
            .collect();
        ensure!(
            matched.len() == 1,
            "Selected USB probe missing or ambiguous"
        );
        let description = matched[0].to_string();
        let mut probe = matched[0].open()?;
        probe.select_protocol(match init.protocol.as_str() {
            "swd" => WireProtocol::Swd,
            "jtag" => WireProtocol::Jtag,
            _ => bail!("Invalid transport"),
        })?;
        let speed = probe.set_speed(init.speed_khz)?;
        let mut session = probe.attach_with_registry(target, Permissions::default(), &registry)?;
        {
            let mut core = session.core(0)?;
            ensure!(
                matches!(core.status()?, CoreStatus::Running | CoreStatus::Sleeping),
                "Target is halted; sampling does not resume it"
            );
        }
        Ok((session, elf, description, speed))
    })();
    let (mut session, elf, description, speed) = match initialized {
        Ok(value) => value,
        Err(error) => {
            reply(&tx, first.id, Err(error))?;
            return Ok(());
        }
    };
    let mut core = session.core(0)?;
    let compared = match verify_flash(&mut core, &elf) {
        Ok(count) => count,
        Err(error) => {
            reply(&tx, first.id, Err(error))?;
            return Ok(());
        }
    };
    reply(
        &tx,
        first.id,
        Ok(
            json!({"protocol": 1, "library": "probe-rs 0.32.0", "probe": description,
        "speedKhz": speed, "elfSha256": format!("{:x}", Sha256::digest(&elf.bytes)), "verifiedBytes": compared,
        "ramRanges": elf.ram.iter().map(|(start, end)| json!({"start": start, "end": end})).collect::<Vec<_>>(),
        "capabilities": {"read": true, "write": false, "peripherals": false, "rtt": false}}),
        ),
    )?;
    let epoch = clock.wall_ms() - clock.now_ms();
    let mut plan: Option<Plan> = None;
    let mut schedule = Schedule::default();
    let mut held = false;
    let mut batch: Option<Batch> = None;
    let mut batch_started = clock.now_ms();
    let mut pending: Option<Vec<u8>> = None;
    loop {
        match rx.try_recv() {
            Ok(request) => {
                let request = request?;
                let result = match request.method.as_str() {
                    "plan" => (|| -> Result<Value> {
                        let next: Plan = serde_json::from_value(request.params)?;
                        next.validate(&elf)?;
                        plan = Some(next);
                        schedule = Schedule::default();
                        batch = None;
                        pending = None;
                        Ok(json!(true))
                    })(),
                    "hold" => {
                        held = request.params.as_bool().context("Invalid host hold")?;
                        Ok(json!(true))
                    }
                    "read" => (|| -> Result<Value> {
                        let ranges: Vec<Range> = serde_json::from_value(request.params)?;
                        memory::validate_ranges(&ranges, &elf.ram)?;
                        let start = clock.now_ms();
                        let bytes = read_ranges(&mut core, &ranges)?;
                        Ok(json!({"bytes": bytes, "t": epoch + (start + clock.now_ms()) / 2.0}))
                    })(),
                    "stop" => {
                        reply(&tx, request.id, Ok(json!(true)))?;
                        break;
                    }
                    _ => Err(anyhow::anyhow!("Unsupported native sampling operation")),
                };
                reply(&tx, request.id, result)?;
                continue;
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }
        if let Some(frame) = pending.take() {
            match tx.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(frame)) => {
                    pending = Some(frame);
                    clock.sleep(Duration::from_millis(1));
                    continue;
                }
                Err(TrySendError::Disconnected(_)) => break,
            }
        }
        if batch.is_some() && (clock.now_ms() - batch_started >= 8.0 || held) {
            pending = Some(batch.take().unwrap().finish());
            continue;
        }
        let Some(current) = &plan else {
            clock.sleep(Duration::from_millis(1));
            continue;
        };
        if held || !current.enabled || (!current.graph && !current.sidebar) {
            clock.sleep(Duration::from_millis(1));
            continue;
        }
        let start = clock.now_ms();
        let recipe = schedule.due(current, start);
        if recipe == 0 {
            clock.sleep(schedule.delay(current, start));
            continue;
        }
        if batch.as_ref().is_some_and(|entry| entry.recipe != recipe) {
            pending = Some(batch.take().unwrap().finish());
        }
        let ranges = &current.recipes[recipe as usize];
        if ranges.is_empty() {
            clock.sleep(Duration::from_millis(1));
            continue;
        }
        let data = read_ranges(&mut core, ranges)?;
        let end = clock.now_ms();
        if batch.is_none() {
            batch = Some(Batch::new(current.generation, recipe, data.len()));
            batch_started = clock.now_ms();
        }
        batch
            .as_mut()
            .unwrap()
            .push(epoch + (start + end) / 2.0, (end - start) as f32, &data);
        if batch.as_ref().unwrap().count >= 64 {
            pending = Some(batch.take().unwrap().finish());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flash_mismatch_reports_the_exact_address_and_bounded_bytes() {
        assert!(compare_flash_chunk(0x08000000, &[1, 2], &[1, 2]).is_ok());
        let error = compare_flash_chunk(0x08001000, &[1, 2, 3], &[1, 9, 3])
            .unwrap_err()
            .to_string();
        assert!(error.contains("0x08001001"));
        assert!(error.contains("ELF [02, 03], target [09, 03]"));
        assert!(compare_flash_chunk(0, &[1], &[]).is_err());
    }
    #[test]
    fn independent_deadlines_skip_missed_ticks() {
        let plan = Plan {
            generation: 1,
            recipes: vec![vec![], vec![], vec![], vec![]],
            graph: true,
            sidebar: true,
            graph_interval_ms: 10.0,
            unlimited: false,
            enabled: true,
        };
        let mut scheduler = Schedule::default();
        assert_eq!(scheduler.due(&plan, 0.0), 3);
        assert_eq!(scheduler.due(&plan, 5.0), 0);
        assert_eq!(scheduler.due(&plan, 10.0), 1);
        assert_eq!(scheduler.due(&plan, 100.0), 3);
        assert_eq!(scheduler.due(&plan, 100.0), 0);
    }
}
