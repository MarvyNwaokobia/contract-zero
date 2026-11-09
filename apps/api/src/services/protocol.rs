//! The mission event protocol: the server's own account of what a player did.
//!
//! The fight runs in the browser (the server has no physics), so the server can't
//! watch the player. What it can do is refuse any account of a mission that the
//! game's rules and physics make impossible. During the run the client streams typed
//! events, and this module folds them into a `FieldState` that the server owns.
//! Completion pays only what that state says was secured.
//!
//! Every event is checked against things the client cannot bend:
//!
//! - **Order and replay.** `seq` strictly increases; a repeat is ignored, never
//!   re-applied. Milestones come in mission order (no charge two before the push).
//! - **Time.** Each event carries the client's clock `t` (ms since deployment), but
//!   the client may never claim more elapsed time than the server has measured
//!   since the session started (+ `CLOCK_SLACK_MS`). Movement and hold durations
//!   are checked on that bounded clock, so a stalled connection doesn't look like
//!   a teleport, and a cheater can't skip real time.
//! - **Movement.** Each position must be reachable from the last at the player's top
//!   speed (with slack), and inside the map.
//! - **Proximity.** An interaction must happen within reach of the object's real
//!   position on the server's copy of the map (`layouts.json`, generated from the
//!   client's levels and checked for drift by a test). Dropped cargo is where it fell.
//! - **Holds.** Taking a case, planting a charge and freeing the seized case need a
//!   `hold_start` near the object at least the hold time earlier.
//! - **Capacity and consumption.** At most `CARRY_MAX` cases; an object taken once is
//!   gone; extraction needs something to extract and a full countdown in the zone.
//!
//! A violation taints the session: nothing it reports afterwards counts, and it
//! settles nothing. What remains possible is a fabricated event stream that obeys
//! all of the above, i.e. a scripted run that takes as long as playing would. See
//! MISSIONS.md for that trust limit.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use cz_economy::mission::{FieldManifest, CASE_SECS, CHARGE_SECS, EXTRACT_SECS, RETRIEVE_SECS};
use cz_economy::OpKind;
use serde::{Deserialize, Serialize};

/// The player's top speed (the client's WALK, m/s), with headroom for being shoved.
pub const MAX_SPEED: f64 = 3.4 * 1.25;
/// Metres of slack on every movement check (spawn offsets, shove, rounding).
pub const MOVE_SLACK: f64 = 2.5;
/// Reach for an interaction, with slack over the client's 2.2 m.
pub const REACH: f64 = 3.4;
/// How close a milestone position must be to its point.
pub const MILESTONE_REACH: f64 = 5.0;
/// How far ahead of the server's measured time the client clock may run.
pub const CLOCK_SLACK_MS: i64 = 3_000;
/// Share of a hold time that must be observed (network and frame timing).
pub const HOLD_TOLERANCE: f64 = 0.85;
pub const CARRY_MAX: usize = 3;
/// Most events one request may carry, and one session in total.
pub const MAX_BATCH: usize = 64;
pub const MAX_EVENTS: i64 = 4_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Zone {
    pub pos: [f64; 2],
    pub radius: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}

/// The server's copy of a map's interaction geometry.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Layout {
    pub start: [f64; 2],
    pub bounds: Bounds,
    pub entry: [f64; 2],
    pub push: [f64; 2],
    pub cases: Vec<[f64; 2]>,
    pub seized: [f64; 2],
    pub charges: Vec<[f64; 2]>,
    pub ammo: Vec<[f64; 2]>,
    pub med: Vec<[f64; 2]>,
    pub exfil: Zone,
    pub handover: Zone,
}

pub static LAYOUTS: LazyLock<BTreeMap<String, Layout>> =
    LazyLock::new(|| serde_json::from_str(include_str!("layouts.json")).expect("layouts.json is valid"));

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    /// A position heartbeat.
    Pos,
    /// An objective point reached: `entry` or `push`.
    Reach { milestone: String },
    /// E pressed and held on an object.
    HoldStart { object: String },
    /// A cargo case taken (raid).
    Collect { object: String },
    /// The seized case taken (recovery).
    Retrieve { object: String },
    /// A charge set (sabotage).
    Plant { object: String },
    /// A supply container used (not economic; recorded only).
    Loot { object: String },
    /// The player went down: what they carry drops here.
    Down,
    /// Extraction (or the handover) called at the zone.
    ExtractCall,
    /// The countdown finished in the zone.
    ExtractComplete,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Event {
    pub seq: i64,
    /// Client clock: ms since deployment.
    pub t: i64,
    pub pos: [f64; 2],
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    InProgress,
    Extracted,
    Tainted,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct FieldState {
    pub phase: Phase,
    pub taint: Option<String>,
    pub last_seq: i64,
    pub last_t: i64,
    pub last_pos: Option<[f64; 2]>,
    pub events: i64,
    pub milestones: Vec<String>,
    pub carried: Vec<String>,
    /// Cargo dropped when the player went down: object → where it lies.
    pub dropped: BTreeMap<String, [f64; 2]>,
    pub planted: Vec<String>,
    pub looted: Vec<String>,
    /// object → client time its hold started.
    pub holds: BTreeMap<String, i64>,
    pub extract_called_t: Option<i64>,
    pub secured: Vec<String>,
    pub delivered: Option<String>,
    /// Events refused without tainting (stale or duplicate), for the audit trail.
    pub ignored: i64,
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Applied,
    /// A repeat or an out-of-date event: dropped, harmless.
    Ignored(&'static str),
    /// Impossible under the rules: the session can no longer earn anything.
    Taint(String),
}

pub struct Ctx<'a> {
    pub kind: OpKind,
    pub layout: &'a Layout,
    pub manifest: &'a FieldManifest,
    /// Server-measured ms since the session started.
    pub server_elapsed_ms: i64,
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

impl<'a> Ctx<'a> {
    /// Where an object stands on this map, or `None` if it isn't one of this op's.
    fn object_pos(&self, id: &str) -> Option<[f64; 2]> {
        let l = self.layout;
        if let Some(i) = self.manifest.cases.iter().position(|c| c.id == id) {
            return Some(if self.kind == OpKind::Recovery { l.seized } else { l.cases[i % l.cases.len()] });
        }
        if let Some(i) = self.manifest.charges.iter().position(|c| c == id) {
            return Some(l.charges[i % l.charges.len()]);
        }
        let (mut a, mut m) = (0usize, 0usize);
        for c in &self.manifest.containers {
            let p = if c.kind == "ammo" { a += 1; l.ammo[(a - 1) % l.ammo.len()] } else { m += 1; l.med[(m - 1) % l.med.len()] };
            if c.id == id {
                return Some(p);
            }
        }
        None
    }

    fn zone(&self) -> &Zone {
        if self.kind == OpKind::Recovery { &self.layout.handover } else { &self.layout.exfil }
    }

    fn can_extract(&self, s: &FieldState) -> bool {
        match self.kind {
            OpKind::Raid => !s.carried.is_empty(),
            OpKind::Recovery => s.carried.iter().any(|c| self.manifest.cases.first().is_some_and(|k| &k.id == c)),
            OpKind::Sabotage => !self.manifest.charges.is_empty() && self.manifest.charges.iter().all(|c| s.planted.contains(c)),
        }
    }
}

/// Fold one event into the state. Pure: the caller persists the result.
pub fn apply(s: &mut FieldState, ctx: &Ctx, e: &Event) -> Verdict {
    if s.phase == Phase::Tainted {
        return Verdict::Ignored("session already failed validation");
    }
    if s.phase == Phase::Extracted {
        return Verdict::Ignored("already extracted");
    }
    if e.seq <= s.last_seq {
        s.ignored += 1;
        return Verdict::Ignored("duplicate or replayed event");
    }
    let v = check(s, ctx, e);
    match &v {
        Verdict::Taint(why) => {
            s.phase = Phase::Tainted;
            s.taint = Some(format!("event {}: {why}", e.seq));
        }
        Verdict::Applied => {
            s.last_seq = e.seq;
            s.last_t = e.t;
            s.last_pos = Some(e.pos);
            s.events += 1;
        }
        Verdict::Ignored(_) => s.ignored += 1,
    }
    v
}

fn check(s: &mut FieldState, ctx: &Ctx, e: &Event) -> Verdict {
    let taint = |m: String| Verdict::Taint(m);
    if s.events >= MAX_EVENTS {
        return taint("too many events for one operation".into());
    }
    // Time: monotonic, and never ahead of what the server has measured.
    if e.t < s.last_t {
        return taint(format!("client clock went backwards ({} < {})", e.t, s.last_t));
    }
    if e.t > ctx.server_elapsed_ms + CLOCK_SLACK_MS {
        return taint(format!("client clock {} ms is ahead of the server's {} ms", e.t, ctx.server_elapsed_ms));
    }
    // Space: inside the map, and reachable from where the player last was.
    let b = &ctx.layout.bounds;
    if !(e.pos[0] >= b.min_x - 2.0 && e.pos[0] <= b.max_x + 2.0 && e.pos[1] >= b.min_z - 2.0 && e.pos[1] <= b.max_z + 2.0) || e.pos.iter().any(|v| !v.is_finite()) {
        return taint(format!("position {:?} is outside the map", e.pos));
    }
    let (from, since) = match s.last_pos {
        Some(p) => (p, s.last_t),
        None => (ctx.layout.start, 0),
    };
    let moved = dist(from, e.pos);
    let allowed = MAX_SPEED * ((e.t - since).max(0) as f64 / 1000.0) + MOVE_SLACK;
    if moved > allowed {
        return taint(format!("impossible movement: {moved:.1} m in {} ms (at most {allowed:.1} m)", e.t - since));
    }

    let near = |id: &str, r: f64| -> Result<[f64; 2], Verdict> {
        let p = s.dropped.get(id).copied().or_else(|| ctx.object_pos(id)).ok_or_else(|| Verdict::Taint(format!("{id} is not an object of this operation")))?;
        if dist(p, e.pos) > r {
            return Err(Verdict::Taint(format!("{id} is {:.1} m away", dist(p, e.pos))));
        }
        Ok(p)
    };
    let held = |s: &FieldState, id: &str, secs: f64| -> Result<(), Verdict> {
        match s.holds.get(id) {
            Some(t0) if (e.t - t0) as f64 >= secs * 1000.0 * HOLD_TOLERANCE => Ok(()),
            Some(t0) => Err(Verdict::Taint(format!("{id} was held {} ms, needs {:.0} ms", e.t - t0, secs * 1000.0))),
            None => Err(Verdict::Taint(format!("{id} was never held"))),
        }
    };
    let has = |m: &str| s.milestones.iter().any(|x| x == m);

    match &e.kind {
        EventKind::Pos => {}
        EventKind::Reach { milestone } => {
            let (p, needs) = match milestone.as_str() {
                "entry" => (ctx.layout.entry, None),
                "push" => (ctx.layout.push, Some("entry")),
                other => return taint(format!("unknown milestone {other}")),
            };
            if let Some(n) = needs {
                if !has(n) {
                    return taint(format!("{milestone} before {n}"));
                }
            }
            if dist(p, e.pos) > MILESTONE_REACH {
                return taint(format!("{milestone} claimed {:.1} m from its point", dist(p, e.pos)));
            }
            if !has(milestone) {
                s.milestones.push(milestone.clone());
            }
        }
        EventKind::HoldStart { object } => {
            if let Err(v) = near(object, REACH) {
                return v;
            }
            s.holds.insert(object.clone(), e.t);
        }
        EventKind::Collect { object } => {
            if ctx.kind != OpKind::Raid || !ctx.manifest.cases.iter().any(|c| &c.id == object) {
                return taint(format!("{object} is not cargo on this raid"));
            }
            if s.carried.contains(object) || s.secured.contains(object) {
                return taint(format!("{object} is already taken"));
            }
            if !has("push") {
                return taint("cargo taken before reaching the inner site".into());
            }
            if s.carried.len() >= CARRY_MAX {
                return taint("carrying more than an operator can".into());
            }
            if let Err(v) = near(object, REACH).and_then(|_| held(s, object, CASE_SECS)) {
                return v;
            }
            s.dropped.remove(object);
            s.holds.remove(object);
            s.carried.push(object.clone());
        }
        EventKind::Retrieve { object } => {
            if ctx.kind != OpKind::Recovery || ctx.manifest.cases.first().map(|c| &c.id) != Some(object) {
                return taint(format!("{object} is not the seized case"));
            }
            if s.carried.contains(object) {
                return taint(format!("{object} is already in hand"));
            }
            if !has("push") {
                return taint("seized case taken before reaching the inner site".into());
            }
            if let Err(v) = near(object, REACH).and_then(|_| held(s, object, RETRIEVE_SECS)) {
                return v;
            }
            s.dropped.remove(object);
            s.holds.remove(object);
            s.carried.push(object.clone());
        }
        EventKind::Plant { object } => {
            let Some(i) = ctx.manifest.charges.iter().position(|c| c == object) else {
                return taint(format!("{object} is not a charge site of this operation"));
            };
            if ctx.kind != OpKind::Sabotage || s.planted.contains(object) {
                return taint(format!("{object} can't be planted again"));
            }
            let needs = if i == 0 { "entry" } else { "push" };
            if !has(needs) {
                return taint(format!("{object} planted before {needs}"));
            }
            if let Err(v) = near(object, REACH).and_then(|_| held(s, object, CHARGE_SECS)) {
                return v;
            }
            s.holds.remove(object);
            s.planted.push(object.clone());
        }
        EventKind::Loot { object } => {
            if !ctx.manifest.containers.iter().any(|c| &c.id == object) {
                return taint(format!("{object} is not a container on this site"));
            }
            if let Err(v) = near(object, REACH) {
                return v;
            }
            if !s.looted.contains(object) {
                s.looted.push(object.clone());
            }
        }
        EventKind::Down => {
            for (k, id) in std::mem::take(&mut s.carried).into_iter().enumerate() {
                let a = k as f64 * 2.1;
                s.dropped.insert(id, [e.pos[0] + a.cos() * 0.7, e.pos[1] + a.sin() * 0.7]);
            }
            s.extract_called_t = None;
        }
        EventKind::ExtractCall => {
            let z = ctx.zone();
            if dist(z.pos, e.pos) > z.radius + 1.0 {
                return taint(format!("extraction called {:.1} m from the zone", dist(z.pos, e.pos)));
            }
            if !ctx.can_extract(s) {
                return taint("extraction called with nothing to extract".into());
            }
            s.extract_called_t = Some(e.t);
        }
        EventKind::ExtractComplete => {
            let z = ctx.zone();
            let Some(t0) = s.extract_called_t else {
                return taint("extraction completed without being called".into());
            };
            if ((e.t - t0) as f64) < EXTRACT_SECS * 1000.0 * HOLD_TOLERANCE {
                return taint(format!("extraction completed after {} ms, needs {:.0}", e.t - t0, EXTRACT_SECS * 1000.0));
            }
            if dist(z.pos, e.pos) > z.radius + 1.0 {
                return taint("extraction completed outside the zone".into());
            }
            if !ctx.can_extract(s) {
                return taint("nothing left to extract".into());
            }
            s.secured = s.carried.iter().filter(|id| ctx.kind == OpKind::Raid && ctx.manifest.cases.iter().any(|c| &c.id == *id)).cloned().collect();
            if ctx.kind == OpKind::Recovery {
                s.delivered = s.carried.first().cloned();
            }
            s.phase = Phase::Extracted;
        }
    }
    Verdict::Applied
}

impl FieldState {
    /// The record completion settles from: the server's, not the client's.
    pub fn record(&self) -> cz_economy::mission::FieldRecord {
        cz_economy::mission::FieldRecord { secured: self.secured.clone(), charges: self.planted.clone(), delivered: self.delivered.clone(), looted: self.looted.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cz_economy::mission::{split_cases, CargoCase, FieldContainer};

    fn layout() -> &'static Layout {
        &LAYOUTS["dustline_depot"]
    }
    fn raid() -> FieldManifest {
        FieldManifest { cases: split_cases(60, "case"), charges: vec![], containers: vec![FieldContainer { id: "ammo-1".into(), kind: "ammo".into(), qty: 3 }] }
    }

    /// A scripted honest player: walks at a legal pace between points.
    struct Run<'a> {
        s: FieldState,
        kind: OpKind,
        m: &'a FieldManifest,
        t: i64,
        pos: [f64; 2],
        seq: i64,
    }
    impl<'a> Run<'a> {
        fn new(kind: OpKind, m: &'a FieldManifest) -> Self {
            Run { s: FieldState::default(), kind, m, t: 0, pos: layout().start, seq: 0 }
        }
        fn send(&mut self, kind: EventKind) -> Verdict {
            self.seq += 1;
            let ctx = Ctx { kind: self.kind, layout: layout(), manifest: self.m, server_elapsed_ms: self.t + 200 };
            apply(&mut self.s, &ctx, &Event { seq: self.seq, t: self.t, pos: self.pos, kind })
        }
        /// Walk to `to` at 3 m/s, sending a heartbeat each second.
        fn walk(&mut self, to: [f64; 2]) {
            loop {
                let d = dist(self.pos, to);
                if d < 0.01 {
                    return;
                }
                let step = d.min(3.0);
                self.pos = [self.pos[0] + (to[0] - self.pos[0]) * step / d, self.pos[1] + (to[1] - self.pos[1]) * step / d];
                self.t += 1000;
                assert_eq!(self.send(EventKind::Pos), Verdict::Applied, "walking");
            }
        }
        fn wait(&mut self, ms: i64) {
            self.t += ms;
        }
        fn hold(&mut self, obj: &str, secs: f64, done: EventKind) -> Verdict {
            assert_eq!(self.send(EventKind::HoldStart { object: obj.into() }), Verdict::Applied);
            self.wait((secs * 1000.0) as i64 + 50);
            self.send(done)
        }
    }

    fn honest_raid(m: &FieldManifest, cases: usize) -> Run<'_> {
        let l = layout();
        let mut r = Run::new(OpKind::Raid, m);
        r.walk(l.entry);
        assert_eq!(r.send(EventKind::Reach { milestone: "entry".into() }), Verdict::Applied);
        r.walk(l.push);
        assert_eq!(r.send(EventKind::Reach { milestone: "push".into() }), Verdict::Applied);
        for i in 0..cases {
            r.walk(l.cases[i]);
            let id = m.cases[i].id.clone();
            assert_eq!(r.hold(&id, CASE_SECS, EventKind::Collect { object: id.clone() }), Verdict::Applied);
        }
        r
    }

    fn extract(r: &mut Run) -> Verdict {
        r.walk(layout().exfil.pos);
        assert_eq!(r.send(EventKind::ExtractCall), Verdict::Applied);
        r.wait((EXTRACT_SECS * 1000.0) as i64 + 50);
        r.send(EventKind::ExtractComplete)
    }

    #[test]
    fn an_honest_raid_secures_exactly_what_it_carried_out() {
        let m = raid();
        let mut r = honest_raid(&m, 2);
        assert_eq!(extract(&mut r), Verdict::Applied);
        assert_eq!(r.s.phase, Phase::Extracted);
        assert_eq!(r.s.record().secured, vec!["case-1", "case-2"]);
    }

    #[test]
    fn claiming_cargo_without_going_there_taints_the_run() {
        let m = raid();
        let mut r = Run::new(OpKind::Raid, &m);
        // Straight from the start: no entry, no push, nowhere near the case.
        assert!(matches!(r.send(EventKind::Collect { object: "case-1".into() }), Verdict::Taint(_)));
        assert_eq!(r.s.phase, Phase::Tainted);
        // Nothing afterwards counts.
        assert!(matches!(r.send(EventKind::Pos), Verdict::Ignored(_)));
    }

    #[test]
    fn teleporting_is_impossible_movement() {
        let m = raid();
        let mut r = Run::new(OpKind::Raid, &m);
        r.t = 1000;
        r.pos = layout().cases[0]; // ~45 m in one second
        assert!(matches!(r.send(EventKind::Pos), Verdict::Taint(w) if w.contains("impossible movement")));
    }

    #[test]
    fn a_client_clock_ahead_of_the_server_is_refused() {
        let m = raid();
        let mut r = Run::new(OpKind::Raid, &m);
        r.seq += 1;
        let ctx = Ctx { kind: OpKind::Raid, layout: layout(), manifest: &m, server_elapsed_ms: 1_000 };
        let v = apply(&mut r.s, &ctx, &Event { seq: r.seq, t: 60_000, pos: layout().start, kind: EventKind::Pos });
        assert!(matches!(v, Verdict::Taint(w) if w.contains("ahead of the server")));
    }

    #[test]
    fn a_tap_is_not_a_hold() {
        let m = raid();
        let mut r = honest_raid(&m, 0);
        r.walk(layout().cases[0]);
        assert_eq!(r.send(EventKind::HoldStart { object: "case-1".into() }), Verdict::Applied);
        r.wait(300);
        assert!(matches!(r.send(EventKind::Collect { object: "case-1".into() }), Verdict::Taint(w) if w.contains("held")));
    }

    #[test]
    fn replayed_events_are_ignored_and_objects_are_taken_once() {
        let m = raid();
        let mut r = honest_raid(&m, 1);
        // Replay the last event's sequence number.
        let last = r.s.last_seq;
        let ctx = Ctx { kind: OpKind::Raid, layout: layout(), manifest: &m, server_elapsed_ms: r.t + 200 };
        let v = apply(&mut r.s, &ctx, &Event { seq: last, t: r.t, pos: r.pos, kind: EventKind::Collect { object: "case-1".into() } });
        assert!(matches!(v, Verdict::Ignored(_)));
        assert_eq!(r.s.carried.len(), 1);
        // Taking the same case again with a new sequence number is impossible.
        assert!(matches!(r.hold("case-1", CASE_SECS, EventKind::Collect { object: "case-1".into() }), Verdict::Taint(w) if w.contains("already taken")));
    }

    #[test]
    fn carrying_more_than_three_is_refused() {
        let m = FieldManifest { cases: split_cases(100, "case"), ..raid() };
        let mut r = honest_raid(&m, 3);
        r.walk(layout().cases[3]);
        assert!(matches!(r.hold("case-4", CASE_SECS, EventKind::Collect { object: "case-4".into() }), Verdict::Taint(w) if w.contains("carrying more")));
    }

    #[test]
    fn mismatched_objects_are_refused() {
        let m = raid();
        let mut r = honest_raid(&m, 0);
        r.walk(layout().cases[0]);
        assert!(matches!(r.send(EventKind::HoldStart { object: "case-99".into() }), Verdict::Taint(w) if w.contains("not an object")));
    }

    #[test]
    fn premature_or_interrupted_extraction_secures_nothing() {
        let m = raid();
        // Called with empty hands.
        let mut r = honest_raid(&m, 0);
        r.walk(layout().exfil.pos);
        assert!(matches!(r.send(EventKind::ExtractCall), Verdict::Taint(w) if w.contains("nothing to extract")));
        // Completed before the countdown ran.
        let mut r = honest_raid(&m, 1);
        r.walk(layout().exfil.pos);
        assert_eq!(r.send(EventKind::ExtractCall), Verdict::Applied);
        r.wait(2_000);
        assert!(matches!(r.send(EventKind::ExtractComplete), Verdict::Taint(w) if w.contains("after")));
        // Going down mid-countdown drops the cargo and cancels it.
        let mut r = honest_raid(&m, 1);
        r.walk(layout().exfil.pos);
        assert_eq!(r.send(EventKind::ExtractCall), Verdict::Applied);
        r.wait(3_000);
        assert_eq!(r.send(EventKind::Down), Verdict::Applied);
        assert!(r.s.carried.is_empty() && r.s.dropped.contains_key("case-1"));
        r.wait(6_000);
        assert!(matches!(r.send(EventKind::ExtractComplete), Verdict::Taint(w) if w.contains("without being called")));
    }

    #[test]
    fn dropped_cargo_is_picked_up_where_it_fell() {
        let m = raid();
        let mut r = honest_raid(&m, 1);
        let fell = r.pos;
        assert_eq!(r.send(EventKind::Down), Verdict::Applied);
        r.wait(2_000);
        assert_eq!(r.hold("case-1", CASE_SECS, EventKind::Collect { object: "case-1".into() }), Verdict::Applied, "picked up again at {fell:?}");
        assert_eq!(extract(&mut r), Verdict::Applied);
        assert_eq!(r.s.record().secured, vec!["case-1"]);
    }

    #[test]
    fn sabotage_needs_both_charges_in_order_and_recovery_the_case() {
        let l = layout();
        let m = FieldManifest { cases: vec![], charges: vec!["charge-1".into(), "charge-2".into()], containers: vec![] };
        let mut r = Run::new(OpKind::Sabotage, &m);
        r.walk(l.entry);
        assert_eq!(r.send(EventKind::Reach { milestone: "entry".into() }), Verdict::Applied);
        r.walk(l.charges[1]);
        assert!(matches!(r.hold("charge-2", CHARGE_SECS, EventKind::Plant { object: "charge-2".into() }), Verdict::Taint(w) if w.contains("before push")));

        let mut r = Run::new(OpKind::Sabotage, &m);
        r.walk(l.entry);
        r.send(EventKind::Reach { milestone: "entry".into() });
        r.walk(l.charges[0]);
        assert_eq!(r.hold("charge-1", CHARGE_SECS, EventKind::Plant { object: "charge-1".into() }), Verdict::Applied);
        r.walk(l.push);
        r.send(EventKind::Reach { milestone: "push".into() });
        r.walk(l.charges[1]);
        assert_eq!(r.hold("charge-2", CHARGE_SECS, EventKind::Plant { object: "charge-2".into() }), Verdict::Applied);
        assert_eq!(extract(&mut r), Verdict::Applied);
        assert_eq!(r.s.record().charges, vec!["charge-1", "charge-2"]);

        let rm = FieldManifest { cases: vec![CargoCase { id: "seized-case".into(), units: 30 }], charges: vec![], containers: vec![] };
        let mut r = Run::new(OpKind::Recovery, &rm);
        r.walk(l.entry);
        r.send(EventKind::Reach { milestone: "entry".into() });
        r.walk(l.push);
        r.send(EventKind::Reach { milestone: "push".into() });
        r.walk(l.seized);
        assert_eq!(r.hold("seized-case", RETRIEVE_SECS, EventKind::Retrieve { object: "seized-case".into() }), Verdict::Applied);
        r.walk(l.handover.pos);
        assert_eq!(r.send(EventKind::ExtractCall), Verdict::Applied);
        r.wait(8_100);
        assert_eq!(r.send(EventKind::ExtractComplete), Verdict::Applied);
        assert_eq!(r.s.record().delivered.as_deref(), Some("seized-case"));
    }

    #[test]
    fn every_layout_parses_and_has_its_objects() {
        for (id, l) in LAYOUTS.iter() {
            assert!(l.cases.len() >= 3 && l.charges.len() == 2 && !l.ammo.is_empty(), "{id}");
        }
    }
}
