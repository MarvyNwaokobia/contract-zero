//! In-process interval jobs (no external cron needed). The agent tick and
//! settlement reconciliation register here as they are built.

use crate::AppState;

pub fn spawn(_state: AppState) {}

#[allow(dead_code)]
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
