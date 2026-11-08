//! In-process interval jobs (no external cron needed).
//!
//! - **World clock:** every `WORLD_TICK_SECS` real seconds (default 60) the world
//!   advances one in-game hour, and the agents decide every `AGENT_EVERY_TICKS`
//!   ticks (default 1). The NPCs act whether or not anyone is playing.
//! - **Session expiry:** raids whose session timed out are failed so a depot is
//!   never held forever.

use crate::AppState;

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn spawn(state: AppState) {
    let tick_secs = env_u64("WORLD_TICK_SECS", 60).max(1);
    let agents_every = env_u64("AGENT_EVERY_TICKS", 1);

    spawn_interval("world-clock", state.clone(), std::time::Duration::from_secs(tick_secs), move |state| {
        Box::pin(async move {
            match state.world.advance(1, agents_every).await {
                Ok(summary) => tracing::debug!("world tick: {summary}"),
                Err(e) => tracing::error!("world tick failed: {e}"),
            }
        })
    });

    spawn_interval("session-expiry", state, std::time::Duration::from_secs(60), |state| {
        Box::pin(async move {
            match crate::handlers::missions::expire_stale_sessions(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::info!("expired {n} stale mission session(s)"),
                Err(e) => tracing::error!("session expiry failed: {e}"),
            }
        })
    });
}

fn spawn_interval<F>(name: &'static str, state: AppState, period: std::time::Duration, job: F)
where
    F: Fn(AppState) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + 'static,
{
    tokio::spawn(async move {
        tracing::info!("scheduler: {} started, every {:?}", name, period);
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;

        loop {
            interval.tick().await;
            job(state.clone()).await;
        }
    });
}
