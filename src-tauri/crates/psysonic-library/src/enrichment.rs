//! Client-side track enrichment — plan/store analysis facts (oximedia BPM/mood).

use std::cmp::Ordering;

use psysonic_core::track_enrichment::{TrackEnrichmentFacts, TrackEnrichmentPlan};

use crate::dto::FactInputDto;
use crate::mood_groups;
use crate::repos::fact::FactRepository;
use crate::store::LibraryStore;

pub const OXIMEDIA_ENRICHMENT_SOURCE_KIND: &str = "analysis";
pub const OXIMEDIA_ENRICHMENT_SOURCE_ID: &str = "oximedia-60s-center";

const ENRICHMENT_KINDS: [&str; 5] = ["bpm", "valence", "arousal", "moods", "mood_tag"];

pub fn mood_tag_source_id(tag: &str) -> String {
    format!("{OXIMEDIA_ENRICHMENT_SOURCE_ID}:{tag}")
}

pub fn plan_track_enrichment(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    now: i64,
) -> Result<TrackEnrichmentPlan, String> {
    let repo = FactRepository::new(store);
    let facts = repo.get(
        server_id,
        track_id,
        &ENRICHMENT_KINDS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        now,
    )?;

    let mut need_moods = !fact_current(&facts, "moods", content_hash);
    if !mood_tags_current(&facts, content_hash) {
        if !backfill_mood_tags_from_stored_moods(store, server_id, track_id, content_hash, now)?
            && !need_moods
        {
            need_moods = true;
        }
    }

    Ok(TrackEnrichmentPlan {
        need_bpm: !fact_current(&facts, "bpm", content_hash),
        need_valence: !fact_current(&facts, "valence", content_hash),
        need_arousal: !fact_current(&facts, "arousal", content_hash),
        need_moods,
    })
}

pub fn store_track_enrichment_facts(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    facts: &TrackEnrichmentFacts,
    now: i64,
) -> Result<(), String> {
    let repo = FactRepository::new(store);
    if let Some(bpm) = facts.bpm {
        repo.put(
            server_id,
            track_id,
            &analysis_fact("bpm", None, Some(bpm.value), content_hash, bpm.confidence),
            now,
        )?;
    }
    if let Some(valence) = facts.valence {
        repo.put(
            server_id,
            track_id,
            &analysis_fact(
                "valence",
                Some(valence.value),
                None,
                content_hash,
                valence.confidence,
            ),
            now,
        )?;
    }
    if let Some(arousal) = facts.arousal {
        repo.put(
            server_id,
            track_id,
            &analysis_fact(
                "arousal",
                Some(arousal.value),
                None,
                content_hash,
                arousal.confidence,
            ),
            now,
        )?;
    }
    if let Some(json) = &facts.moods {
        if !json.is_empty() {
            repo.put(
                server_id,
                track_id,
                &analysis_fact_text("moods", json, content_hash, 1.0),
                now,
            )?;
            let tags = mood_tag_ids_from_moods_json(json);
            if !tags.is_empty() {
                replace_mood_tag_facts(store, server_id, track_id, content_hash, &tags, now)?;
            }
        }
    }
    Ok(())
}

fn backfill_mood_tags_from_stored_moods(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    now: i64,
) -> Result<bool, String> {
    let repo = FactRepository::new(store);
    let facts = repo.get(server_id, track_id, &["moods".into()], now)?;
    let Some(json) = facts
        .iter()
        .find(|f| {
            is_oximedia_primary_fact(f)
                && f.fact_kind == "moods"
                && f.content_hash.as_deref() == Some(content_hash)
        })
        .and_then(|f| f.value_text.as_deref())
    else {
        return Ok(false);
    };
    let tags = mood_tag_ids_from_moods_json(json);
    if tags.is_empty() {
        return Ok(false);
    }
    replace_mood_tag_facts(store, server_id, track_id, content_hash, &tags, now)?;
    Ok(true)
}

fn replace_mood_tag_facts(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    tags: &[String],
    now: i64,
) -> Result<(), String> {
    let like_prefix = format!("{OXIMEDIA_ENRICHMENT_SOURCE_ID}:%");
    store
        .with_conn("enrichment.mood_tags_clear", |conn| {
            conn.execute(
                "DELETE FROM track_fact \
                 WHERE server_id = ?1 AND track_id = ?2 \
                   AND fact_kind = 'mood_tag' \
                   AND source_kind = ?3 \
                   AND source_id LIKE ?4",
                rusqlite::params![
                    server_id,
                    track_id,
                    OXIMEDIA_ENRICHMENT_SOURCE_KIND,
                    like_prefix,
                ],
            )?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    let repo = FactRepository::new(store);
    for tag in tags {
        if !mood_groups::is_oximedia_mood_tag(tag) {
            continue;
        }
        repo.put(
            server_id,
            track_id,
            &mood_tag_fact(tag, content_hash),
            now,
        )?;
    }
    Ok(())
}

fn mood_tag_ids_from_moods_json(json: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(obj) = parsed.as_object() else {
        return Vec::new();
    };
    let mut scored: Vec<(String, f64)> = obj
        .iter()
        .filter_map(|(k, v)| v.as_f64().map(|score| (k.clone(), score)))
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored
        .into_iter()
        .take(3)
        .map(|(k, _)| k)
        .filter(|k| mood_groups::is_oximedia_mood_tag(k))
        .collect()
}

fn mood_tag_fact(tag: &str, content_hash: &str) -> FactInputDto {
    FactInputDto {
        fact_kind: "mood_tag".to_string(),
        value_real: None,
        value_int: None,
        value_text: Some(tag.to_string()),
        unit: None,
        source_kind: OXIMEDIA_ENRICHMENT_SOURCE_KIND.to_string(),
        source_id: mood_tag_source_id(tag),
        confidence: 1.0,
        content_hash: Some(content_hash.to_string()),
        expires_at: None,
    }
}

fn is_oximedia_primary_fact(f: &crate::dto::TrackFactDto) -> bool {
    f.source_kind == OXIMEDIA_ENRICHMENT_SOURCE_KIND && f.source_id == OXIMEDIA_ENRICHMENT_SOURCE_ID
}

fn fact_current(
    facts: &[crate::dto::TrackFactDto],
    fact_kind: &str,
    content_hash: &str,
) -> bool {
    facts.iter().any(|f| {
        is_oximedia_primary_fact(f)
            && f.fact_kind == fact_kind
            && f.content_hash.as_deref() == Some(content_hash)
    })
}

fn mood_tags_current(facts: &[crate::dto::TrackFactDto], content_hash: &str) -> bool {
    facts.iter().any(|f| {
        f.fact_kind == "mood_tag"
            && f.source_kind == OXIMEDIA_ENRICHMENT_SOURCE_KIND
            && f.source_id.starts_with(&format!("{OXIMEDIA_ENRICHMENT_SOURCE_ID}:"))
            && f.content_hash.as_deref() == Some(content_hash)
    })
}

fn analysis_fact_text(
    fact_kind: &str,
    value_text: &str,
    content_hash: &str,
    confidence: f32,
) -> FactInputDto {
    FactInputDto {
        fact_kind: fact_kind.to_string(),
        value_real: None,
        value_int: None,
        value_text: Some(value_text.to_string()),
        unit: None,
        source_kind: OXIMEDIA_ENRICHMENT_SOURCE_KIND.to_string(),
        source_id: OXIMEDIA_ENRICHMENT_SOURCE_ID.to_string(),
        confidence: confidence.clamp(0.0, 1.0) as f64,
        content_hash: Some(content_hash.to_string()),
        expires_at: None,
    }
}

fn analysis_fact(
    fact_kind: &str,
    value_real: Option<f64>,
    value_int: Option<i64>,
    content_hash: &str,
    confidence: f32,
) -> FactInputDto {
    FactInputDto {
        fact_kind: fact_kind.to_string(),
        value_real,
        value_int,
        value_text: None,
        unit: None,
        source_kind: OXIMEDIA_ENRICHMENT_SOURCE_KIND.to_string(),
        source_id: OXIMEDIA_ENRICHMENT_SOURCE_ID.to_string(),
        confidence: confidence.clamp(0.0, 1.0) as f64,
        content_hash: Some(content_hash.to_string()),
        expires_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::FactInputDto;
    use psysonic_core::track_enrichment::{
        TrackEnrichmentFacts, TrackEnrichmentIntFact, TrackEnrichmentRealFact,
    };

    fn seed_track(store: &LibraryStore, server: &str, id: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track (server_id, id, title, synced_at, raw_json) \
                     VALUES (?1, ?2, 'T', 1, '{}')",
                    rusqlite::params![server, id],
                )
            })
            .unwrap();
    }

    fn put_analysis_fact(
        store: &LibraryStore,
        kind: &str,
        hash: &str,
        value_int: Option<i64>,
        value_real: Option<f64>,
        value_text: Option<&str>,
    ) {
        let repo = FactRepository::new(store);
        repo.put(
            "s1",
            "t1",
            &FactInputDto {
                fact_kind: kind.into(),
                value_real,
                value_int,
                value_text: value_text.map(str::to_string),
                unit: None,
                source_kind: OXIMEDIA_ENRICHMENT_SOURCE_KIND.into(),
                source_id: OXIMEDIA_ENRICHMENT_SOURCE_ID.into(),
                confidence: 0.9,
                content_hash: Some(hash.into()),
                expires_at: None,
            },
            1,
        )
        .unwrap();
    }

    #[test]
    fn plan_requests_all_when_no_facts() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
        assert!(plan.need_bpm && plan.need_valence && plan.need_arousal && plan.need_moods);
    }

    #[test]
    fn plan_skips_current_hash_only() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        put_analysis_fact(&store, "bpm", "abc", Some(120), None, None);
        let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
        assert!(!plan.need_bpm);
        assert!(plan.need_valence && plan.need_arousal && plan.need_moods);
        let plan2 = plan_track_enrichment(&store, "s1", "t1", "def", 2).unwrap();
        assert!(plan2.need_bpm);
    }

    #[test]
    fn plan_backfills_mood_tags_from_moods_json_without_reanalysis() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        put_analysis_fact(
            &store,
            "moods",
            "abc",
            None,
            None,
            Some(r#"{"calm":0.6,"peaceful":0.4}"#),
        );
        let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
        assert!(!plan.need_moods, "moods JSON is current — no re-analysis");
        let repo = FactRepository::new(&store);
        let tags: Vec<_> = repo
            .get("s1", "t1", &["mood_tag".into()], 3)
            .unwrap()
            .into_iter()
            .filter(|f| f.fact_kind == "mood_tag")
            .map(|f| f.value_text.unwrap_or_default())
            .collect();
        assert_eq!(tags, vec!["calm", "peaceful"]);
    }

    #[test]
    fn store_writes_mood_tag_rows_from_moods_json() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let facts = TrackEnrichmentFacts {
            bpm: None,
            valence: None,
            arousal: None,
            moods: Some(r#"{"happy":0.7,"excited":0.5}"#.into()),
        };
        store_track_enrichment_facts(&store, "s1", "t1", "abc", &facts, 10).unwrap();
        let repo = FactRepository::new(&store);
        let rows = repo.get("s1", "t1", &[], 20).unwrap();
        assert!(rows.iter().any(|r| r.fact_kind == "moods"));
        let mood_tags: Vec<_> = rows
            .iter()
            .filter(|r| r.fact_kind == "mood_tag")
            .map(|r| r.value_text.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(mood_tags, vec!["happy", "excited"]);
    }

    #[test]
    fn store_writes_only_provided_facts() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1");
        let facts = TrackEnrichmentFacts {
            bpm: Some(TrackEnrichmentIntFact {
                value: 128,
                confidence: 0.8,
            }),
            valence: Some(TrackEnrichmentRealFact {
                value: 0.4,
                confidence: 1.0,
            }),
            arousal: None,
            moods: None,
        };
        store_track_enrichment_facts(&store, "s1", "t1", "abc", &facts, 10).unwrap();
        let repo = FactRepository::new(&store);
        let rows = repo.get("s1", "t1", &[], 20).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.fact_kind == "bpm" && r.value_int == Some(128)));
        assert!(rows.iter().any(|r| r.fact_kind == "valence"));
        assert!(!rows.iter().any(|r| r.fact_kind == "arousal"));
    }
}
