//! Where operations happen, and what the hour does to them.
//!
//! Every operation is bound to a **site**: a real place in the Dustline basin that a
//! faction holds, with named facilities where each resource is kept. The site comes
//! from who owns the stock, what the stock is and what the operation is for, so the
//! same contract is always at the same place:
//!
//! | Target | Operation | Site | Why |
//! |---|---|---|---|
//! | Vanguard | raid or sabotage on ammunition or fuel | Dustline Depot | the munitions line and the motor-pool fuel depot are there |
//! | Vanguard | raid on medicine | Blacksite | medical stores are kept in the vault |
//! | Vanguard | recovery (seized caravan cargo) | Blacksite | seized goods go where Vanguard keeps what it does not log |
//! | Ashen Compact | anything | Cinder Yard | the refinery holds everything the Compact owns |
//!
//! The clock no longer moves the objective. It sets the **conditions** at the site:
//! lighting, how far guards see, how fast reinforcements come, and whether night
//! vision is issued.

use serde::{Deserialize, Serialize};

use crate::{OpKind, Resource, TICKS_PER_DAY};

/// A playable map. Each site plays on one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    DustlineDepot,
    Blacksite,
    CinderYard,
}

impl Layout {
    pub fn name(self) -> &'static str {
        match self {
            Layout::DustlineDepot => "dustline_depot",
            Layout::Blacksite => "blacksite",
            Layout::CinderYard => "cinder_yard",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Site {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
    /// What kind of place it is.
    pub environment: &'static str,
    /// The faction that holds it.
    pub owner: &'static str,
    pub layout: Layout,
    /// True while the site borrows another site's map because its own isn't built.
    pub shared_layout: bool,
    /// Where each resource is kept, indexed like `Resource::idx` (ammo, med, fuel).
    pub stores: [&'static str; 3],
    /// Where seized caravan cargo is held.
    pub holding: &'static str,
    /// The production line a sabotage hits, per resource (empty: not produced here).
    pub lines: [&'static str; 3],
    /// How you leave.
    pub exfil: &'static str,
    /// Where a recovered cargo is handed back.
    pub handover: &'static str,
}

pub const DUSTLINE_DEPOT: Site = Site {
    id: "dustline-depot",
    name: "Dustline Depot",
    region: "Dustline basin, south road",
    environment: "Outdoor logistics yard: motor pool, container wall, warehouse",
    owner: "vanguard",
    layout: Layout::DustlineDepot,
    shared_layout: false,
    stores: ["munitions warehouse", "warehouse aid store", "motor-pool fuel depot"],
    holding: "container yard",
    lines: ["munitions line", "", "fuel depot"],
    exfil: "Vex's flatbed at the south gate",
    handover: "Vex's truck at the east fence",
};

pub const BLACKSITE: Site = Site {
    id: "blacksite",
    name: "Blacksite",
    region: "Dustline basin, north ridge",
    environment: "Fortified research facility: floodlit courtyard, labs, control room, vault",
    owner: "vanguard",
    layout: Layout::Blacksite,
    shared_layout: false,
    stores: ["armoury vault", "medical vault", "APC motor bay"],
    holding: "control room",
    lines: ["server room", "", "APC motor bay"],
    exfil: "landing zone outside the gate",
    handover: "the gate, to the owner's escort",
};

pub const CINDER_YARD: Site = Site {
    id: "cinder-yard",
    name: "Cinder Yard",
    region: "Dustline basin, refinery flats",
    environment: "Refinery: tank farm, fractionation columns, loading bay, arms shed, control room",
    owner: "ashen",
    layout: Layout::CinderYard,
    shared_layout: false,
    // Everything the Compact ships is staged at the loading bay.
    stores: ["loading bay", "loading bay", "loading bay"],
    holding: "control room",
    lines: ["", "", "fractionation unit"],
    exfil: "the flatbed on the road outside the south gate",
    handover: "the owner's truck at the east fence",
};

pub const SITES: [Site; 3] = [DUSTLINE_DEPOT, BLACKSITE, CINDER_YARD];

pub fn site(id: &str) -> Option<&'static Site> {
    SITES.iter().find(|s| s.id == id)
}

/// The site an operation happens at, from what it is against.
pub fn site_for(target: &str, kind: OpKind, resource: Resource) -> &'static Site {
    match target {
        "ashen" => &SITES[2],
        _ => match (kind, resource) {
            (OpKind::Recovery, _) => &SITES[1],
            (OpKind::Raid, Resource::Med) => &SITES[1],
            _ => &SITES[0],
        },
    }
}

/// The facility inside the site that the operation is about.
pub fn facility(site: &Site, kind: OpKind, resource: Resource) -> &'static str {
    match kind {
        OpKind::Recovery => site.holding,
        OpKind::Sabotage if !site.lines[resource.idx()].is_empty() => site.lines[resource.idx()],
        _ => site.stores[resource.idx()],
    }
}

// ── Time of day ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Day,
    Dusk,
    Night,
}

impl Phase {
    pub fn at(tick: u64) -> Phase {
        match tick % TICKS_PER_DAY {
            6..=16 => Phase::Day,
            17..=20 => Phase::Dusk,
            _ => Phase::Night,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Phase::Day => "day",
            Phase::Dusk => "dusk",
            Phase::Night => "night",
        }
    }
    /// The hour this phase starts.
    pub fn starts(self) -> u64 {
        match self {
            Phase::Day => 6,
            Phase::Dusk => 17,
            Phase::Night => 21,
        }
    }
    pub fn next(self) -> Phase {
        match self {
            Phase::Day => Phase::Dusk,
            Phase::Dusk => Phase::Night,
            Phase::Night => Phase::Day,
        }
    }
}

/// What the hour does at a site. Applied by the client's mission builder; the same
/// numbers are shown in the briefing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conditions {
    pub phase: Phase,
    pub hour: u64,
    pub lighting: String,
    /// Metres a guard can engage at.
    pub sight_m: u32,
    /// Guard accuracy relative to daylight, in basis points.
    pub accuracy_bp: u32,
    /// Reinforcement interval relative to normal, in basis points (lower = faster).
    pub reinforce_bp: u32,
    pub nvg: bool,
    pub patrol: String,
    pub next_phase: Phase,
    pub next_change_hour: u64,
    /// Game hours (ticks) until the next change.
    pub ticks_to_change: u64,
}

pub fn conditions(tick: u64) -> Conditions {
    let phase = Phase::at(tick);
    let hour = tick % TICKS_PER_DAY;
    let next = phase.next();
    let to = (next.starts() + TICKS_PER_DAY - hour) % TICKS_PER_DAY;
    let (lighting, sight_m, accuracy_bp, reinforce_bp, nvg, patrol) = match phase {
        Phase::Day => ("Full daylight", 30, 10_000, 10_000, false, "Day shift: full patrols, long sight lines"),
        Phase::Dusk => ("Low sun, long shadows", 26, 9_200, 8_000, false, "Shift change: relief squads arrive faster"),
        Phase::Night => ("Dark: floodlights and lamps only", 20, 8_000, 11_000, true, "Night watch: short sight lines, slower to reinforce; NVG issued"),
    };
    Conditions {
        phase,
        hour,
        lighting: lighting.into(),
        sight_m,
        accuracy_bp,
        reinforce_bp,
        nvg,
        patrol: patrol.into(),
        next_phase: next,
        next_change_hour: next.starts(),
        ticks_to_change: if to == 0 { TICKS_PER_DAY } else { to },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_contract_stays_at_its_site_at_every_hour() {
        let s = site_for("vanguard", OpKind::Raid, Resource::Ammo);
        assert_eq!(s.id, "dustline-depot");
        assert_eq!(site_for("vanguard", OpKind::Recovery, Resource::Fuel).id, "blacksite");
        assert_eq!(site_for("vanguard", OpKind::Raid, Resource::Med).id, "blacksite");
        assert_eq!(site_for("ashen", OpKind::Sabotage, Resource::Fuel).id, "cinder-yard");
        assert_eq!(site_for("ashen", OpKind::Raid, Resource::Ammo).layout, Layout::CinderYard);
        assert!(SITES.iter().all(|s| !s.shared_layout), "every site has its own map");
        assert_eq!(facility(s, OpKind::Sabotage, Resource::Ammo), "munitions line");
    }

    #[test]
    fn the_clock_sets_conditions_not_places() {
        assert_eq!(conditions(10).phase, Phase::Day);
        assert_eq!(conditions(18).phase, Phase::Dusk);
        assert_eq!(conditions(23).phase, Phase::Night);
        assert_eq!(conditions(3).phase, Phase::Night);
        let c = conditions(14);
        assert_eq!((c.next_phase, c.ticks_to_change), (Phase::Dusk, 3));
        let n = conditions(22);
        assert_eq!((n.next_phase, n.ticks_to_change), (Phase::Day, 8));
        assert!(n.nvg && n.sight_m < c.sight_m);
    }

    #[test]
    fn every_site_owner_and_layout_is_known() {
        for s in SITES {
            assert!(["vanguard", "ashen"].contains(&s.owner));
            assert!(!s.stores.iter().any(|f| f.is_empty()));
        }
    }
}

// ── What the world is doing at a site, right now ─────────────────────────────

/// A production line at a site that is down (sabotaged), and until when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineDown {
    pub resource: Resource,
    /// The site's own name for the line ("fractionation unit").
    pub line: String,
    /// The tick it comes back.
    pub until: u64,
}

/// A shipment of the site owner's that is about to arrive, or just did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivery {
    pub resource: Resource,
    pub units: i64,
    pub arrives_at: u64,
    /// "arriving" (on the road, in its last stretch) or "arrived" (within the last hours).
    pub state: String,
}

/// The state of a site's economy the fight can show. Read from the world at one tick, and fixed
/// for a mission when it starts, like the rest of its plan.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldCues {
    pub tick: u64,
    pub lines_down: Vec<LineDown>,
    pub deliveries: Vec<Delivery>,
}

/// A shipment counts as "arriving" for this many ticks before it lands, and as "arrived" for
/// this many after.
pub const DELIVERY_WINDOW_TICKS: u64 = 3;
pub const ARRIVED_WINDOW_TICKS: u64 = 6;

/// What is really happening at `site`: which of its production lines are down, and whether the
/// owner has a shipment landing or just landed. Nothing here is estimated.
pub fn world_cues(w: &crate::World, site: &Site) -> WorldCues {
    let mut cues = WorldCues { tick: w.tick, ..Default::default() };
    let Some(owner) = w.actors.get(site.owner) else { return cues };
    for r in Resource::ALL {
        let line = site.lines[r.idx()];
        if !line.is_empty() && owner.disrupted_until[r.idx()] > w.tick {
            cues.lines_down.push(LineDown { resource: r, line: line.to_string(), until: owner.disrupted_until[r.idx()] });
        }
    }
    for c in w.convoys.values().filter(|c| c.owner == site.owner) {
        let state = match c.status {
            crate::ConvoyStatus::InTransit if c.arrives_at.saturating_sub(w.tick) <= DELIVERY_WINDOW_TICKS => "arriving",
            crate::ConvoyStatus::Arrived if w.tick.saturating_sub(c.arrives_at) < ARRIVED_WINDOW_TICKS => "arrived",
            _ => continue,
        };
        cues.deliveries.push(Delivery { resource: c.resource, units: c.units, arrives_at: c.arrives_at, state: state.to_string() });
    }
    cues
}
