use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub trait Clock {
    fn now_ms(&self) -> f64;
    fn wall_ms(&self) -> f64;
    fn sleep(&self, duration: Duration);
}
pub struct SystemClock {
    start: Instant,
}
impl SystemClock {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}
impl Clock for SystemClock {
    fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    fn wall_ms(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System clock")
            .as_secs_f64()
            * 1000.0
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
