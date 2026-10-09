#![no_std]
#![no_main]

use core::panic::PanicInfo;
use core::sync::atomic::{AtomicU32, Ordering};

#[used]
pub static GAIN: AtomicU32 = AtomicU32::new(123);

#[used]
pub static mut OFFSET: f32 = 1.5;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
pub extern "C" fn Reset() -> ! {
    loop {
        let _ = GAIN.load(Ordering::Relaxed);
    }
}
