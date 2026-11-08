use dashmap::DashMap;
use std::time::Instant;

/// Simple per-key sliding-window rate limiter backed by DashMap.
/// Safe for concurrent access across Actix worker threads.
pub struct RateLimiter {
    buckets:     DashMap<String, (Instant, u32)>,
    limit:       u32,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(limit: u32, window_secs: u64) -> Self {
        Self { buckets: DashMap::new(), limit, window_secs }
    }

    /// Returns `true` if the request is within the rate limit, `false` if it should be rejected.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut entry = self.buckets.entry(key.to_string()).or_insert((now, 0));

        if now.duration_since(entry.0).as_secs() >= self.window_secs {
            // Window expired — reset
            *entry = (now, 1);
            true
        } else if entry.1 < self.limit {
            entry.1 += 1;
            true
        } else {
            false
        }
    }
}
