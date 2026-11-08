//! The live economy: one `World` behind one lock.
//!
//! Every command runs under the lock, so commands are serialized and there are no
//! concurrent-order races to reason about. After each committed change the full
//! state is snapshotted to Postgres; if that write fails, the in-memory change is
//! rolled back so memory and the database never disagree.

use std::sync::Arc;

use cz_economy::{policy, Action, Caller, EconError, Event, World};
use cz_economy::policy::Decision;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum WorldError {
    #[error(transparent)]
    Econ(#[from] EconError),
    #[error("storage: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Other(String),
}

#[derive(Clone)]
pub struct WorldService {
    world: Arc<Mutex<World>>,
    db: PgPool,
}

/// Snapshots kept per world; older ones are pruned.
const KEEP_SNAPSHOTS: i64 = 500;

impl WorldService {
    /// Load the latest snapshot, or create the genesis world from `WORLD_SEED`.
    pub async fn load(db: PgPool) -> anyhow::Result<Self> {
        let latest: Option<(Value,)> =
            sqlx::query_as("SELECT state FROM world_snapshots ORDER BY id DESC LIMIT 1").fetch_optional(&db).await?;
        let world = match latest {
            Some((state,)) => serde_json::from_value(state)?,
            None => {
                let seed = std::env::var("WORLD_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(2026);
                let w = cz_economy::genesis(seed);
                persist(&db, &w).await?;
                tracing::info!("world: created genesis world (seed {seed})");
                w
            }
        };
        tracing::info!("world: loaded at tick {} (version {})", world.tick, world.version);
        Ok(Self { world: Arc::new(Mutex::new(world)), db })
    }

    pub fn db(&self) -> &PgPool {
        &self.db
    }

    /// Run a read-only view of the world.
    pub async fn read<T>(&self, f: impl FnOnce(&World) -> T) -> T {
        f(&*self.world.lock().await)
    }

    /// Run `f` against the world under the lock, then persist. On any error the world
    /// is restored to its state before `f`.
    pub async fn transact<T, F>(&self, f: F) -> Result<T, WorldError>
    where
        F: AsyncFnOnce(&mut World, &PgPool) -> Result<T, WorldError>,
    {
        let mut w = self.world.lock().await;
        let before = w.clone();
        let out = match f(&mut w, &self.db).await {
            Ok(v) => v,
            Err(e) => {
                *w = before;
                return Err(e);
            }
        };
        if w.version != before.version {
            if let Err(e) = persist(&self.db, &w).await {
                *w = before;
                return Err(e.into());
            }
        }
        Ok(out)
    }

    /// Execute one command as `caller` and log it.
    pub async fn execute(&self, caller: Caller, action: Action, source: &str) -> Result<Vec<Event>, WorldError> {
        let source = source.to_string();
        self.transact(async move |w, db| {
            let ev = w.execute(&caller, &action)?;
            log_event(db, w.tick, &source, "economy", &json!({ "action": action, "events": summarize(&ev) })).await?;
            Ok(ev)
        })
        .await
    }

    /// Advance `ticks` ticks, running the agents every `agents_every` ticks. Returns a
    /// summary of what happened. Used by the scheduler and by fast-forward.
    pub async fn advance(&self, ticks: u64, agents_every: u64) -> Result<Value, WorldError> {
        self.transact(async move |w, db| {
            let mut shortages = 0usize;
            let mut decisions = 0usize;
            let mut notable = Vec::new();
            for _ in 0..ticks {
                for e in w.tick() {
                    match e {
                        Event::Shortage { .. } => shortages += 1,
                        Event::Transfer(_) => {}
                        other => notable.push(other),
                    }
                }
                if agents_every > 0 && w.tick % agents_every == 0 {
                    for (decision, result) in policy::run_fallback_agents(w) {
                        decisions += 1;
                        log_decision(db, w.tick, "fallback", &decision, result.as_ref()).await?;
                    }
                }
            }
            for e in &notable {
                log_event(db, w.tick, "system", "economy", &json!({ "event": e })).await?;
            }
            Ok(json!({ "ticks": ticks, "tick": w.tick, "decisions": decisions, "shortages": shortages, "events": notable.len() }))
        })
        .await
    }
}

async fn persist(db: &PgPool, w: &World) -> Result<(), sqlx::Error> {
    let state = serde_json::to_value(w).expect("world serializes");
    sqlx::query("INSERT INTO world_snapshots (tick, version, state) VALUES ($1, $2, $3)")
        .bind(w.tick as i64)
        .bind(w.version as i64)
        .bind(state)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM world_snapshots WHERE id <= (SELECT max(id) FROM world_snapshots) - $1")
        .bind(KEEP_SNAPSHOTS)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn log_event(db: &PgPool, tick: u64, source: &str, kind: &str, payload: &Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO world_events (tick, source, kind, payload) VALUES ($1, $2, $3, $4)")
        .bind(tick as i64)
        .bind(source)
        .bind(kind)
        .bind(payload)
        .execute(db)
        .await?;
    Ok(())
}

/// Record an agent decision with its validation and execution result: the War Room's
/// causal record. `planner` is "llm" or "fallback".
pub async fn log_decision(
    db: &PgPool,
    tick: u64,
    planner: &str,
    d: &Decision,
    result: Option<&Result<Vec<Event>, EconError>>,
) -> Result<(), sqlx::Error> {
    let (validation, error, events) = match result {
        None => ("no_action", None, vec![]),
        Some(Ok(ev)) => ("accepted", None, summarize(ev)),
        Some(Err(e)) => ("rejected", Some(e.to_string()), vec![]),
    };
    let payload = json!({
        "planner": planner,
        "trigger": d.trigger,
        "context": d.context,
        "action": d.action,
        "rationale": d.rationale,
        "validation": validation,
        "error": error,
        "events": events,
    });
    log_event(db, tick, &d.actor, "agent_decision", &payload).await
}

/// Domain events only; individual ledger transfers stay in the snapshot's ledger.
pub fn summarize(ev: &[Event]) -> Vec<&Event> {
    ev.iter().filter(|e| !matches!(e, Event::Transfer(_))).collect()
}
