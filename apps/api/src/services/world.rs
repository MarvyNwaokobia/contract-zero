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
use sqlx::{PgConnection, PgPool};
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
    /// NEAR settlement, when configured. `None` keeps the economy fully off-chain.
    near: Option<Arc<super::near::NearClient>>,
}

/// Mirror issuance/destruction on chain every this many ticks (and always before a
/// trade or raid settles).
const FLOW_SYNC_TICKS: u64 = 12;

/// Snapshots kept per world; older ones are pruned.
const KEEP_SNAPSHOTS: i64 = 500;

impl WorldService {
    /// Load the latest snapshot, or create the genesis world from `WORLD_SEED`.
    pub async fn load(db: PgPool, near: Option<Arc<super::near::NearClient>>) -> anyhow::Result<Self> {
        let latest: Option<(Value,)> =
            sqlx::query_as("SELECT state FROM world_snapshots ORDER BY id DESC LIMIT 1").fetch_optional(&db).await?;
        let world = match latest {
            Some((state,)) => serde_json::from_value(state)?,
            None => {
                // WORLD_SCENARIO=acceptance starts from the end-to-end acceptance state.
                let scenario = std::env::var("WORLD_SCENARIO").unwrap_or_default();
                let w = if scenario == "acceptance" {
                    cz_economy::acceptance()
                } else {
                    cz_economy::genesis(std::env::var("WORLD_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(2026))
                };
                persist(&mut *db.acquire().await?, &w).await?;
                tracing::info!("world: created {} world (seed {})", if scenario == "acceptance" { "acceptance" } else { "genesis" }, w.seed);
                w
            }
        };
        // A live world that predates the Ashen Compact gains it, provided settlement
        // (when on) can sign for it; its starting stock is genesis issuance and is
        // mirrored on chain by the next flow sync.
        let mut world: World = world;
        let can_sign = near.as_ref().is_none_or(|n| n.actor_account("ashen").is_some());
        if world.market.living && can_sign && cz_economy::add_rival(&mut world) {
            persist(&mut *db.acquire().await?, &world).await?;
            tracing::info!("world: the Ashen Compact joined at tick {}", world.tick);
        }
        // Likewise the second merchant, Halcyon Logistics.
        let can_sign = near.as_ref().is_none_or(|n| n.actor_account("halcyon").is_some());
        if world.market.living && can_sign && cz_economy::add_halcyon(&mut world) {
            persist(&mut *db.acquire().await?, &world).await?;
            tracing::info!("world: Halcyon Logistics joined at tick {}", world.tick);
        }
        tracing::info!("world: loaded at tick {} (version {})", world.tick, world.version);
        Ok(Self { world: Arc::new(Mutex::new(world)), db, near })
    }

    pub fn db(&self) -> &PgPool {
        &self.db
    }

    pub fn near(&self) -> Option<Arc<super::near::NearClient>> {
        self.near.clone()
    }

    /// Run a read-only view of the world.
    pub async fn read<T>(&self, f: impl FnOnce(&World) -> T) -> T {
        f(&*self.world.lock().await)
    }

    /// Run `f` against the world under the lock, then persist. On any error the world
    /// is restored to its state before `f`.
    /// Run `f` against the world and the database as ONE unit. Every row `f` writes
    /// (events, sessions, settlements) and the new world snapshot go into a single
    /// PostgreSQL transaction, committed only if `f` and the snapshot both succeed.
    /// On any error the transaction rolls back AND the in-memory world is restored,
    /// so neither side ever keeps half of an action.
    ///
    /// `f` must not call the chain: a NEAR transaction can't be rolled back. Chain
    /// calls happen outside (the settlement worker, the exchange's quote flow).
    pub async fn transact<T, F>(&self, f: F) -> Result<T, WorldError>
    where
        F: AsyncFnOnce(&mut World, &mut PgConnection) -> Result<T, WorldError>,
    {
        let mut w = self.world.lock().await;
        let before = w.clone();
        let mut tx = self.db.begin().await?;
        let result = async {
            let out = f(&mut w, &mut tx).await?;
            if w.version != before.version {
                persist(&mut tx, &w).await?;
            }
            Ok::<T, WorldError>(out)
        }
        .await;
        match result {
            Ok(out) => match tx.commit().await {
                Ok(()) => Ok(out),
                Err(e) => {
                    *w = before;
                    Err(e.into())
                }
            },
            Err(e) => {
                *w = before;
                let _ = tx.rollback().await;
                Err(e)
            }
        }
    }

    /// Execute one command as `caller` and log it.
    pub async fn execute(&self, caller: Caller, action: Action, source: &str) -> Result<Vec<Event>, WorldError> {
        let source = source.to_string();
        self.transact(async move |w, db| {
            let ev = w.execute(&caller, &action)?;
            log_event(&mut *db, w.tick, &source, "economy", &json!({ "action": action, "events": summarize(&ev) })).await?;
            Ok(ev)
        })
        .await
    }

    /// Advance `ticks` ticks, running the agents every `agents_every` ticks. Returns a
    /// summary of what happened. Used by the scheduler and by fast-forward.
    pub async fn advance(&self, ticks: u64, agents_every: u64) -> Result<Value, WorldError> {
        let near = self.near.clone();
        self.transact(async move |w, db| {
            let mut shortages = 0usize;
            let mut decisions = 0usize;
            let mut notable = Vec::new();
            for _ in 0..ticks {
                record_history(w, &mut *db).await?;
                let tick_events = w.tick();
                if let Some(near) = &near {
                    super::settlement::queue_order_steps(w, &mut *db, near, &tick_events).await?;
                }
                for e in tick_events {
                    match e {
                        Event::Shortage { .. } => shortages += 1,
                        Event::Transfer(_) => {}
                        other => notable.push(other),
                    }
                }
                if agents_every > 0 && w.tick % agents_every == 0 {
                    for (decision, result) in policy::run_fallback_agents(w) {
                        decisions += 1;
                        log_decision(&mut *db, w.tick, "fallback", &decision, result.as_ref()).await?;
                        // An accepted trade with the merchant (a purchase or a sale)
                        // settles on NEAR.
                        if let (Some(near), Some(Ok(events))) = (&near, &result) {
                            for e in events {
                                if let Event::Traded(t) = e {
                                    // Order fills settle as order steps, not instant trades.
                                    if t.order.is_none() {
                                        super::settlement::queue_trade(w, &mut *db, near, t).await?;
                                    }
                                }
                            }
                            super::settlement::queue_order_steps(w, &mut *db, near, events).await?;
                        }
                    }
                }
            }
            if let Some(near) = &near {
                if w.tick % FLOW_SYNC_TICKS == 0 {
                    super::settlement::sync_flows(w, &mut *db, near).await?;
                }
            }
            for e in &notable {
                log_event(&mut *db, w.tick, "system", "economy", &json!({ "event": e })).await?;
            }
            Ok(json!({ "ticks": ticks, "tick": w.tick, "decisions": decisions, "shortages": shortages, "events": notable.len() }))
        })
        .await
    }
}

async fn persist(db: &mut PgConnection, w: &World) -> Result<(), sqlx::Error> {
    let state = serde_json::to_value(w).expect("world serializes");
    sqlx::query("INSERT INTO world_snapshots (tick, version, state) VALUES ($1, $2, $3)")
        .bind(w.tick as i64)
        .bind(w.version as i64)
        .bind(state)
        .execute(&mut *db)
        .await?;
    sqlx::query("DELETE FROM world_snapshots WHERE id <= (SELECT max(id) FROM world_snapshots) - $1")
        .bind(KEEP_SNAPSHOTS)
        .execute(&mut *db)
        .await?;
    Ok(())
}

pub async fn log_event<'e, E: sqlx::PgExecutor<'e>>(db: E, tick: u64, source: &str, kind: &str, payload: &Value) -> Result<(), sqlx::Error> {
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
pub async fn log_decision<'e, E: sqlx::PgExecutor<'e>>(
    db: E,
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

/// Prices and holdings at this tick, for the War Room's history.
async fn record_history(w: &World, db: &mut PgConnection) -> Result<(), sqlx::Error> {
    let prices: serde_json::Map<String, Value> = cz_economy::Resource::ALL.iter().map(|&r| { let p = w.price(r); (r.name().to_string(), json!({ "ask": p.ask, "bid": p.bid, "stock": w.merchant_stock(r) })) }).collect();
    let holdings: serde_json::Map<String, Value> = w.actors.values().map(|a| (a.id.clone(), json!({
        "credits": w.balance(&a.account, cz_economy::Asset::Credits),
        "ammo": w.balance(&a.account, cz_economy::Asset::Res(cz_economy::Resource::Ammo)),
        "med": w.balance(&a.account, cz_economy::Asset::Res(cz_economy::Resource::Med)),
        "fuel": w.balance(&a.account, cz_economy::Asset::Res(cz_economy::Resource::Fuel)),
        "defense": a.defense,
    }))).collect();
    sqlx::query("INSERT INTO market_history (tick, prices, holdings) VALUES ($1, $2, $3) ON CONFLICT (tick) DO NOTHING")
        .bind(w.tick as i64).bind(Value::Object(prices)).bind(Value::Object(holdings)).execute(&mut *db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed action leaves nothing behind: not the rows it wrote, not the world change.
    /// Needs CZ_DB_TESTS=1 and DATABASE_URL (it reads the dev world but writes nothing
    /// that survives).
    #[tokio::test]
    async fn a_failed_transaction_rolls_back_the_database_and_the_world() {
        if std::env::var("CZ_DB_TESTS").as_deref() != Ok("1") {
            return;
        }
        dotenvy::dotenv().ok();
        let db = PgPool::connect(&std::env::var("DATABASE_URL").unwrap()).await.unwrap();
        let svc = WorldService { world: Arc::new(Mutex::new(cz_economy::acceptance())), db: db.clone(), near: None };
        let tag = format!("test-atomic-{}", uuid::Uuid::new_v4());
        let before = svc.read(|w| w.version).await;
        let t = tag.clone();
        let r: Result<(), WorldError> = svc
            .transact(async move |w, db| {
                log_event(&mut *db, w.tick, &t, "test", &json!({ "step": 1 })).await?;
                w.version += 1; // a change in memory
                Err(WorldError::Other("fails after writing".into()))
            })
            .await;
        assert!(r.is_err());
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM world_events WHERE source = $1").bind(&tag).fetch_one(&db).await.unwrap();
        assert_eq!(n, 0, "the event written before the failure was rolled back");
        assert_eq!(svc.read(|w| w.version).await, before, "the world was restored");
        // And a successful one commits.
        let t = tag.clone();
        svc.transact(async move |w, db| { log_event(&mut *db, w.tick, &t, "test", &json!({})).await?; Ok(()) }).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM world_events WHERE source = $1").bind(&tag).fetch_one(&db).await.unwrap();
        assert_eq!(n, 1);
        sqlx::query("DELETE FROM world_events WHERE source = $1").bind(&tag).execute(&db).await.unwrap();
    }
}
