//! Mission narrative: the briefing, the radio over the fight and the debrief.
//!
//! Every line is built from facts the server can vouch for at the moment the
//! mission starts (who is paying, why, what the target remembers about this player)
//! or completes (what the operation did). The authored templates below always
//! produce a complete story. When the NEAR AI planner is configured, a model may
//! rewrite those lines in character, but each rewrite is checked (`check_rewrite`):
//! no number, name or claim that the authored line did not already carry. A line
//! that fails keeps its authored text. The model never decides what happened.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use cz_economy::mission::RaidPlan;
use cz_economy::{World, TICKS_PER_DAY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::planner::Planner;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub id: String,
    pub speaker: String,
    pub text: String,
}

/// What the story may talk about, captured when the mission starts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Facts {
    pub kind: String,
    pub target: String,
    pub target_name: String,
    pub resource: String,
    pub manifest: i64,
    pub defense: u8,
    pub guards: i64,
    pub sponsor: Option<String>,
    pub sponsor_name: Option<String>,
    pub amount: i64,
    /// The sponsor's own logged rationale for posting this contract.
    pub sponsor_reason: Option<String>,
    pub zone: String,
    pub tick: u64,
    pub callsign: Option<String>,
    /// This player's record against the target before this mission.
    pub raids: u32,
    pub sabotage: u32,
    pub recoveries: u32,
    pub units_lost: i64,
    /// A rival that has paid for raids on the target, if any.
    pub rival_sponsor: Option<String>,
    pub aggression: u8,
    pub seed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Story {
    pub codename: String,
    pub location: String,
    pub time: String,
    pub briefing: Vec<Line>,
    /// Radio lines by scene trigger (see apps/web/src/engine/story/presence.ts).
    pub radio: BTreeMap<String, Vec<Line>>,
    /// "authored", or "llm:<model>" when at least one line was rewritten.
    pub source: String,
    #[serde(default)]
    pub rewrites: Vec<Value>,
}

pub fn facts(w: &World, plan: &RaidPlan, player: &str) -> Facts {
    let target = &w.actors[&plan.target];
    let contract = crate::handlers::world::plan_contract(w, plan);
    let memory = w.memory.get(&plan.target);
    let g = memory.and_then(|m| m.players.get(player)).cloned().unwrap_or_default();
    let rival = memory.and_then(|m| m.sponsors.iter().max_by_key(|(_, t)| t.len())).and_then(|(s, _)| w.actors.get(s)).map(|a| a.name.clone());
    Facts {
        kind: plan.kind.name().to_string(),
        target: plan.target.clone(),
        target_name: target.name.clone(),
        resource: plan.resource.name().to_string(),
        manifest: plan.manifest,
        defense: plan.defense,
        guards: plan.guards.deployed(),
        sponsor: contract.map(|b| b.sponsor.clone()),
        sponsor_name: contract.map(|b| w.actors[&b.sponsor].name.clone()),
        amount: contract.map(|b| b.amount).unwrap_or(0),
        sponsor_reason: None,
        zone: crate::handlers::world::zone_for_tick(w.tick).to_string(),
        tick: w.tick,
        callsign: None,
        raids: g.raids,
        sabotage: g.sabotage,
        recoveries: g.recoveries,
        units_lost: g.units_lost,
        rival_sponsor: rival,
        aggression: target.doctrine.aggression,
        seed: cz_economy::splitmix(w.seed ^ w.tick.wrapping_mul(0x9E37_79B9) ^ (w.raids.len() as u64).wrapping_mul(0x85EB_CA6B)),
    }
}

fn spoken(resource: &str) -> &str {
    match resource {
        "ammo" => "ammunition",
        "med" => "medical supplies",
        _ => resource,
    }
}

const CODE_A: [&str; 12] = ["GLASS", "IRON", "PALE", "QUIET", "RED", "SALT", "COLD", "HOLLOW", "ASH", "BRASS", "GREY", "LONG"];
const CODE_B: [&str; 12] = ["HARROW", "LANTERN", "TIDE", "LEDGER", "ANVIL", "SPARROW", "MERIDIAN", "FURNACE", "WICK", "COMPASS", "TALLY", "MOTH"];

fn clock(tick: u64) -> String {
    format!("Day {}, {:02}:00", tick / TICKS_PER_DAY, tick % TICKS_PER_DAY)
}

fn line(id: &str, speaker: &str, text: String) -> Line {
    Line { id: format!("dyn-{id}"), speaker: speaker.to_string(), text }
}

/// The complete authored story for a mission. Deterministic in its facts.
pub fn authored(f: &Facts) -> Story {
    let res = spoken(&f.resource);
    let t = f.target_name.as_str();
    let tv = f.target.as_str(); // the target's radio voice
    let who = f.callsign.clone().unwrap_or_else(|| "Contractor".into());
    let sponsor = f.sponsor_name.as_deref();
    let sv = f.sponsor.as_deref().unwrap_or("vex");
    let kind = f.kind.as_str();

    let mut briefing = vec![line("brief-job", "handler", match (kind, sponsor) {
        ("sabotage", Some(s)) => format!("{who}, {s} is paying {} credits to put {t}'s {res} line out of action. Two charges, then get clear.", f.amount),
        ("recovery", Some(s)) => format!("{who}, {t} took a {s} caravan on the road. {s} pays {} credits to get its {} {res} back.", f.amount, f.manifest),
        ("raid", Some(s)) => format!("{who}, {s} has a {} credit bounty on {t}'s {res}. {} units in the depot, and whatever you carry out is yours.", f.amount, f.manifest),
        _ => format!("{who}, nobody's paying on this one. {} units of {res} in {t}'s depot. Whatever you carry out is yours to sell.", f.manifest),
    })];
    if let (Some(reason), Some(_)) = (&f.sponsor_reason, sponsor) {
        if reason.len() <= 160 {
            briefing.push(line("brief-sponsor", sv, reason.clone()));
        }
    }
    briefing.push(line("brief-intel", "handler", {
        let mut s = format!("{t} has this site at defense level {}: {} guards armed and waiting.", f.defense, f.guards);
        if f.raids + f.sabotage + f.recoveries > 0 {
            s.push_str(&format!(" They know your name. You've hit them {} times.", f.raids + f.sabotage + f.recoveries));
        } else if let Some(r) = &f.rival_sponsor {
            s.push_str(&format!(" They're already jumpy: {r} has been paying for raids on them."));
        }
        s
    }));

    let mut radio: BTreeMap<String, Vec<Line>> = BTreeMap::new();
    let mut put = |trigger: &str, l: Line| radio.entry(trigger.to_string()).or_default().push(l);

    put("opStart", line("start", "handler", match kind {
        "sabotage" => format!("Two charge points on the {res} line. Plant both and get clear. You don't have to win the fight."),
        "recovery" => format!("The stolen {res} is in their cache. Secure it and walk it to the handover."),
        _ => format!("Contract's live. The {res} is in the yard past the hall. Load it and walk it out."),
    }));
    put("opBreach", line("breach", "handler", "You're in. They're awake now, so keep moving.".into()));
    put("troopsCleared", line("cleared", "handler", format!("Forward escort's down. Someone just keyed in on the {t} channel.")));
    put("rivalFirstWord", line("rival", tv, {
        let total = f.raids + f.sabotage + f.recoveries;
        match (tv, kind, total) {
            (_, _, n) if n >= 2 => format!("{who}. Again. That's {} times now. We keep count.", n + 1),
            (_, _, 1) => format!("{who}. We remember you. This time we were ready."),
            ("ashen", "sabotage", _) => "Ashen Compact. Get away from the line. Fire walks with the Compact, not against it.".into(),
            ("ashen", _, _) => "This is the Ashen Compact. You're standing in our refinery. Nobody leaves the refinery.".into(),
            (_, "sabotage", _) => "This is Vanguard. Someone is on the production line. Shoot on sight.".into(),
            (_, "recovery", _) => "This is Vanguard. That cargo is ours now. Seized fair, held fair.".into(),
            _ => "This is Vanguard. That cargo is accounted for. You will be too.".into(),
        }
    }));
    put("opPushIn", line("push", "handler", match kind {
        "sabotage" => "One charge set. The second goes on the line inside. Don't stand still while it arms.".into(),
        "recovery" => "Cache is close. Hold it until it's secure, then head for the handover.".into(),
        _ => "That's the yard. Get on the cargo and start loading. They'll try to take it back.".into(),
    }));
    put("finaleReveal", line("finale", tv, if tv == "ashen" { "Every barrel you touch costs you. The Compact collects.".into() } else { "Every crate you carry out, we pay for twice. Remember that when the next convoy rolls.".into() }));
    put("lowHp", line("lowhp", "handler", "You're hit. Get behind something. The job isn't going anywhere.".into()));
    put("opHeroDown", line("down", tv, "Intruder down. Log it, and send the bill to whoever hired them.".into()));
    put("missionCleared", line("done", if sponsor.is_some() { sv } else { "vex" }, match (kind, sponsor) {
        ("sabotage", Some(_)) => format!("That line's dark for a day and a half. {} credits, as agreed.", f.amount),
        ("recovery", Some(_)) => format!("That's my cargo home. {} credits are yours.", f.amount),
        ("raid", Some(s)) if s != "Vex Exchange" => format!("{s} here. The bounty's paid: {} credits. Good hunting.", f.amount),
        _ => "Lovely. Bring it round to the exchange. I'll have the credits ready.".into(),
    }));

    let a = f.seed as usize;
    Story {
        codename: format!("OPERATION {} {}", CODE_A[a % CODE_A.len()], CODE_B[(a / CODE_A.len()) % CODE_B.len()]),
        location: format!("{} · held by {t}", if f.zone == "BLACKSITE" { "Blacksite" } else { "Dustline Depot" }),
        time: format!("{} · {}", clock(f.tick), match f.zone.as_str() { "BLACKSITE" => "night", "REDYARD" => "dusk", _ => "day" }),
        briefing,
        radio,
        source: "authored".into(),
        rewrites: vec![],
    }
}

/// What happened, in the cast's voices. `result` is the stored mission result;
/// `after` is the target's memory of this player once the operation settled.
pub fn debrief(f: &Facts, result: &Value, after: Option<&cz_economy::Grievance>) -> Vec<Line> {
    let res = spoken(&f.resource);
    let t = &f.target_name;
    let who = f.callsign.clone().unwrap_or_else(|| "Contractor".into());
    let units = result["extracted_units"].as_i64().unwrap_or(0);
    let bounty = result["bounty"].as_i64().unwrap_or(0);
    let mut out = vec![];
    match result["outcome"].as_str() {
        Some("extracted") => {
            out.push(line("debrief-handler", "handler", match f.kind.as_str() {
                "sabotage" => {
                    let until = result["events"].as_array().into_iter().flatten().find(|e| e["event"] == "production_disrupted").and_then(|e| e["until"].as_u64());
                    match until {
                        Some(u) => format!("{units} {res} destroyed. {t}'s line is down until {}. Fee's {bounty} credits.", clock(u)),
                        None => format!("{units} {res} destroyed. Fee's {bounty} credits."),
                    }
                }
                "recovery" => format!("{units} {res} back where it belongs. {bounty} credits for you, none of the cargo."),
                _ if bounty > 0 => format!("{units} {res} out, plus a {bounty} credit bounty. Sell it or keep it."),
                _ => format!("{units} {res} out. Sell it on the Exchange or keep it."),
            }));
            if let Some(g) = after {
                let n = g.raids + g.sabotage + g.recoveries;
                out.push(line("debrief-target", &f.target, if n > 1 {
                    format!("{who}. That's {n} operations against {t}. We are not forgetting any of them.")
                } else {
                    format!("We have your name now, {who}. {t} remembers.")
                }));
            }
        }
        Some("killed") => {
            out.push(line("debrief-handler", "handler", "We lost you in there. Nothing paid, and the contract's back on the board.".into()));
            out.push(line("debrief-target", &f.target, format!("Intruder stopped. {t} holds.")));
        }
        _ => out.push(line("debrief-handler", "handler", "Command didn't accept the run. Nothing moved.".into())),
    }
    out
}

// ── model rewrite, checked ──

const BANNED: [&str; 12] = ["blockchain", "near", "crypto", "token", "wallet", "nft", "ai", "llm", "model", "chain", "web3", "transaction"];

fn numbers(s: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() { cur.push(c) } else if !cur.is_empty() { out.insert(std::mem::take(&mut cur)); }
    }
    if !cur.is_empty() { out.insert(cur); }
    out
}

fn names(s: &str) -> BTreeSet<String> {
    // Capitalised words that do not open a sentence: names, places, factions.
    let mut out = BTreeSet::new();
    let mut opener = true;
    for raw in s.split_whitespace() {
        let w: String = raw.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect();
        if !opener && w.chars().next().is_some_and(|c| c.is_uppercase()) && w != "I" && !w.starts_with("I'") {
            out.insert(w.trim_end_matches("'s").to_string());
        }
        opener = raw.ends_with(['.', '!', '?', ':']);
    }
    out
}

/// A rewrite is accepted only if it says nothing the authored line could not:
/// the same numbers (no new ones, none dropped), no new names, no out-of-world
/// vocabulary, and still short enough to read as a subtitle.
pub fn check_rewrite(original: &str, rewrite: &str, allowed_names: &BTreeSet<String>) -> Result<(), String> {
    let r = rewrite.trim();
    if r.len() < 8 || r.len() > 170 {
        return Err(format!("length {}", r.len()));
    }
    if numbers(r) != numbers(original) {
        return Err(format!("numbers changed: {:?} → {:?}", numbers(original), numbers(r)));
    }
    let lower = r.to_lowercase();
    for b in BANNED {
        if lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == b) {
            return Err(format!("out-of-world word \"{b}\""));
        }
    }
    let known = names(original);
    for n in names(r) {
        if !known.contains(&n) && !allowed_names.contains(&n) {
            return Err(format!("new name \"{n}\""));
        }
    }
    Ok(())
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": { "lines": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "text": { "type": "string" } }, "required": ["id", "text"], "additionalProperties": false } } },
        "required": ["lines"], "additionalProperties": false,
    })
}

const CAST: &str = "KESTREL (handler): calm, dry, transactional; on the contractor's side while the contract is.\n\
VANGUARD COMMAND: disciplined, cold, bureaucratic menace; counts everything.\n\
ASHEN COMPACT: zealous fuel refiners; fire and ash imagery; threatens in short sentences.\n\
VEX (Vex Exchange): the merchant; warm in the way a business is warm.";

/// Ask the model to voice the authored lines; keep only rewrites that pass the check.
pub async fn rewrite(planner: &Planner, story: &mut Story, f: &Facts) -> Value {
    let mut lines: Vec<&mut Line> = story.briefing.iter_mut().chain(story.radio.values_mut().flatten()).collect();
    let input: Vec<Value> = lines.iter().map(|l| json!({ "id": l.id, "speaker": l.speaker, "text": l.text })).collect();
    let system = format!("You voice radio lines for CONTRACT ZERO, a tactical extraction shooter. Cast:\n{CAST}\n\nRewrite each line in its speaker's voice. Rules: keep every number exactly as written and add none; mention no person, place or faction that the line does not already name; keep each line under 150 characters; no out-of-world words (never mention blockchains, tokens, AI or the game's systems). Return every id.");
    let user = json!({ "situation": f, "lines": input }).to_string();
    let started = std::time::Instant::now();
    let reply = planner.complete_json("story", schema(), &system, &user, 1200, Duration::from_secs(10)).await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let (raw, usage) = match reply {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "error": e, "latency_ms": latency_ms, "fallback": "authored lines" }),
    };
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let allowed: BTreeSet<String> = ["Kestrel", "Vanguard", "Ashen", "Compact", "Vex", "Exchange", "Dustline", "Depot", "Blacksite", "Command"]
        .iter().map(|s| s.to_string()).chain(f.callsign.clone()).chain(f.sponsor_name.iter().flat_map(|s| s.split(' ').map(String::from).collect::<Vec<_>>())).collect();
    let mut accepted = 0;
    for item in parsed["lines"].as_array().into_iter().flatten() {
        let (Some(id), Some(text)) = (item["id"].as_str(), item["text"].as_str()) else { continue };
        let Some(l) = lines.iter_mut().find(|l| l.id == id) else { continue };
        match check_rewrite(&l.text, text, &allowed) {
            Ok(()) => {
                story.rewrites.push(json!({ "id": id, "accepted": true, "authored": l.text }));
                l.text = text.trim().to_string();
                accepted += 1;
            }
            Err(why) => story.rewrites.push(json!({ "id": id, "accepted": false, "reason": why, "proposed": text })),
        }
    }
    if accepted > 0 {
        story.source = format!("llm:{}", planner.model);
    }
    json!({ "ok": true, "latency_ms": latency_ms, "usage": usage, "accepted": accepted, "proposed": parsed["lines"].as_array().map(|a| a.len()).unwrap_or(0) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(kind: &str, sponsor: Option<(&str, &str)>) -> Facts {
        Facts {
            kind: kind.into(), target: "vanguard".into(), target_name: "Vanguard".into(), resource: "ammo".into(),
            manifest: 75, defense: 4, guards: 13, sponsor: sponsor.map(|s| s.0.into()), sponsor_name: sponsor.map(|s| s.1.into()),
            amount: if sponsor.is_some() { 435 } else { 0 }, zone: "DUSTLINE".into(), tick: 276, seed: 7, ..Default::default()
        }
    }

    #[test]
    fn every_kind_gets_a_complete_story_that_names_the_real_terms() {
        for (kind, sponsor) in [("raid", None), ("raid", Some(("ashen", "Ashen Compact"))), ("sabotage", Some(("vex", "Vex Exchange"))), ("recovery", Some(("vex", "Vex Exchange")))] {
            let s = authored(&f(kind, sponsor));
            for t in ["opStart", "opBreach", "troopsCleared", "rivalFirstWord", "opPushIn", "lowHp", "opHeroDown", "missionCleared"] {
                assert!(s.radio.get(t).is_some_and(|l| !l.is_empty()), "{kind}: no {t}");
            }
            let all: Vec<&Line> = s.briefing.iter().chain(s.radio.values().flatten()).collect();
            assert!(all.iter().all(|l| l.text.len() < 170 && l.id.starts_with("dyn-")));
            let brief = &s.briefing[0].text;
            if let Some((_, name)) = sponsor { assert!(brief.contains(name) && brief.contains("435"), "{brief}") }
            assert!(s.briefing.iter().any(|l| l.text.contains("13 guards")));
            assert!(s.codename.starts_with("OPERATION "));
        }
    }

    #[test]
    fn the_target_speaks_with_its_own_voice_and_remembers_the_player() {
        let mut a = f("raid", None);
        a.target = "ashen".into();
        a.target_name = "Ashen Compact".into();
        let s = authored(&a);
        assert_eq!(s.radio["rivalFirstWord"][0].speaker, "ashen");
        assert!(s.radio["rivalFirstWord"][0].text.contains("Ashen Compact"));
        a.raids = 3;
        a.callsign = Some("Wren".into());
        let s = authored(&a);
        assert!(s.radio["rivalFirstWord"][0].text.contains("4 times"), "{}", s.radio["rivalFirstWord"][0].text);
        assert!(s.briefing.iter().any(|l| l.text.contains("hit them 3 times")));
    }

    #[test]
    fn rewrites_may_not_change_facts_or_break_the_fiction() {
        let allowed: BTreeSet<String> = ["Vanguard", "Vex"].iter().map(|s| s.to_string()).collect();
        let o = "Vex Exchange is paying 435 credits to put Vanguard's ammunition line out of action.";
        assert!(check_rewrite(o, "Vex pays 435 credits if Vanguard's ammunition line goes dark.", &allowed).is_ok());
        assert!(check_rewrite(o, "Vex pays 900 credits if Vanguard's line goes dark.", &allowed).is_err(), "changed number");
        assert!(check_rewrite(o, "Vex pays credits if the line goes dark.", &allowed).is_err(), "dropped number");
        assert!(check_rewrite(o, "Vex pays 435 credits; Halcyon wants the line dark too.", &allowed).is_err(), "invented name");
        assert!(check_rewrite(o, "Vex pays 435 credits, settled on chain.", &allowed).is_err(), "out-of-world word");
        assert!(check_rewrite(o, &"x".repeat(200), &allowed).is_err());
    }

    #[test]
    fn the_debrief_reports_what_the_result_says() {
        let r = json!({ "outcome": "extracted", "extracted_units": 75, "bounty": 435, "events": [{ "event": "production_disrupted", "until": 312 }] });
        let g = cz_economy::Grievance { sabotage: 2, ..Default::default() };
        let d = debrief(&f("sabotage", Some(("vex", "Vex Exchange"))), &r, Some(&g));
        assert!(d[0].text.contains("75") && d[0].text.contains("435") && d[0].text.contains("Day 13, 00:00"), "{}", d[0].text);
        assert!(d[1].text.contains("2 operations"));
        let k = debrief(&f("raid", None), &json!({ "outcome": "killed" }), None);
        assert!(k[0].text.contains("Nothing paid"));
    }
}
