#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU32, Ordering};
use defmt::info;
use embassy_time::Timer;
use {defmt_rtt as _, panic_probe as _};

/// Monotonic heartbeat for LiveWatch and waveform validation.
#[used]
pub static TICKS: AtomicU32 = AtomicU32::new(0);

/// Runtime parameter to set to 50, 100, or 250 ms from the sidebar.
#[used]
pub static TUNE_MS: AtomicU32 = AtomicU32::new(100);

/// Last period accepted by the firmware; confirms the tuning took effect.
#[used]
pub static APPLIED_MS: AtomicU32 = AtomicU32::new(100);

#[embassy_executor::main]
async fn main(_spawner: embassy_executor::Spawner) {
    let _peripherals = embassy_stm32::init(Default::default());
    loop {
        let period = TUNE_MS.load(Ordering::Relaxed).clamp(20, 1000);
        APPLIED_MS.store(period, Ordering::Relaxed);
        let ticks = TICKS.fetch_add(1, Ordering::Relaxed) + 1;
        if ticks % 10 == 0 {
            info!("emberprobe smoke ticks={} period_ms={}", ticks, period);
        }
        Timer::after_millis(period as u64).await;
    }
}
