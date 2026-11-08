//! Slack alerting — the "tell a human when something is actually wrong" side of
//! monitoring. Deliberately not wired to every `tracing::error!` call site (most
//! of those are routine per-request DB error logs); call `slack_alert` only from
//! the handful of places whose entire job is noticing real trouble, e.g. the
//! consistency check's `!healthy` branch.

/// Posts `text` to `SLACK_ALERT_WEBHOOK_URL` as a Slack incoming-webhook message.
/// No-ops (debug log only) if the env var isn't set — same "absent = disabled"
/// convention as the rest of this codebase's optional integrations. Fire-and-forget:
/// spawned so a slow or failing webhook never blocks or fails the caller.
#[allow(dead_code)]
pub async fn slack_alert(text: &str) {
    let Ok(webhook_url) = std::env::var("SLACK_ALERT_WEBHOOK_URL") else {
        tracing::debug!("slack_alert (no SLACK_ALERT_WEBHOOK_URL set, not sent): {}", text);
        return;
    };

    let text = text.to_string();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let result = client
            .post(&webhook_url)
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => tracing::warn!("slack_alert: webhook returned {}", resp.status()),
            Err(e) => tracing::warn!("slack_alert: failed to reach webhook: {}", e),
        }
    });
}
