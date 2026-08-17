//! Client-side track enrichment — plan/store analysis facts (oximedia BPM/mood).

use psysonic_core::track_enrichment::{TrackEnrichmentFacts, TrackEnrichmentPlan};

use crate::dto::FactInputDto;
use crate::mood_groups;
use crate::repos::fact::FactRepository;
use crate::store::LibraryStore;

pub const OXIMEDIA_ENRICHMENT_SOURCE_KIND: &str = "analysis";
pub const OXIMEDIA_ENRICHMENT_SOURCE_ID: &str = "oximedia-60s-center";

/// Oximedia 0.1.7 mood is a spectral energy heuristic (not ML). Disabled until
/// the crate ships a reliable classifier; re-enable plan/store/analysis together.
pub const OXIMEDIA_MOOD_ANALYSIS_ENABLED: bool = false;

/// Derived mood tags for search/UI — requires analysis + a usable model.
pub const OXIMEDIA_MOOD_TAGS_ENABLED: bool = OXIMEDIA_MOOD_ANALYSIS_ENABLED;

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
        &ENRICHMENT_KINDS
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        now,
    )?;

    let (need_valence, need_arousal, need_moods) = if OXIMEDIA_MOOD_ANALYSIS_ENABLED {
        let mut need_moods = !fact_current(&facts, "moods", content_hash);
        if OXIMEDIA_MOOD_TAGS_ENABLED {
            if !mood_tags_current(&facts, content_hash)
                && !backfill_mood_tags_from_stored_facts(
                    store,
                    server_id,
                    track_id,
                    content_hash,
                    now,
                )?
                && !need_moods
            {
                need_moods = true;
            } else if mood_tags_current(&facts, content_hash)
                && mood_tags_need_va_refresh(&facts, content_hash)
            {
                let _ = backfill_mood_tags_from_stored_facts(
                    store,
                    server_id,
                    track_id,
                    content_hash,
                    now,
                )?;
            }
        }
        (
            !fact_current(&facts, "valence", content_hash),
            !fact_current(&facts, "arousal", content_hash),
            need_moods,
        )
    } else {
        (false, false, false)
    };

    Ok(TrackEnrichmentPlan {
        need_bpm: !fact_current(&facts, "bpm", content_hash),
        need_valence,
        need_arousal,
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
    if OXIMEDIA_MOOD_ANALYSIS_ENABLED {
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
            }
        }
    }
    let tags = mood_tags_for_enrichment_facts(facts, 2);
    if OXIMEDIA_MOOD_TAGS_ENABLED && !tags.is_empty() {
        replace_mood_tag_facts(store, server_id, track_id, content_hash, &tags, now)?;
    }
    Ok(())
}

fn mood_tags_for_enrichment_facts(facts: &TrackEnrichmentFacts, limit: usize) -> Vec<String> {
    if let (Some(v), Some(a)) = (facts.valence, facts.arousal) {
        return mood_groups::top_mood_tag_ids_from_valence_arousal(v.value, a.value, limit);
    }
    if let Some(json) = &facts.moods {
        return mood_groups::top_distinct_oximedia_mood_tag_ids_from_moods_json(json, limit);
    }
    Vec::new()
}

fn mood_tags_from_stored_facts(
    facts: &[crate::dto::TrackFactDto],
    content_hash: &str,
    limit: usize,
) -> Vec<String> {
    let matches_hash =
        |f: &&crate::dto::TrackFactDto| f.content_hash.as_deref() == Some(content_hash);
    let valence = facts
        .iter()
        .find(|f| is_oximedia_primary_fact(f) && f.fact_kind == "valence" && matches_hash(f))
        .and_then(|f| f.value_real);
    let arousal = facts
        .iter()
        .find(|f| is_oximedia_primary_fact(f) && f.fact_kind == "arousal" && matches_hash(f))
        .and_then(|f| f.value_real);
    if let (Some(v), Some(a)) = (valence, arousal) {
        return mood_groups::top_mood_tag_ids_from_valence_arousal(v, a, limit);
    }
    let Some(json) = facts
        .iter()
        .find(|f| is_oximedia_primary_fact(f) && f.fact_kind == "moods" && matches_hash(f))
        .and_then(|f| f.value_text.as_deref())
    else {
        return Vec::new();
    };
    mood_groups::top_distinct_oximedia_mood_tag_ids_from_moods_json(json, limit)
}

fn backfill_mood_tags_from_stored_facts(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    now: i64,
) -> Result<bool, String> {
    let repo = FactRepository::new(store);
    let facts = repo.get(
        server_id,
        track_id,
        &["moods".into(), "valence".into(), "arousal".into()],
        now,
    )?;
    let tags = mood_tags_from_stored_facts(&facts, content_hash, 2);
    if tags.is_empty() {
        return Ok(false);
    }
    replace_mood_tag_facts(store, server_id, track_id, content_hash, &tags, now)?;
    Ok(true)
}

fn mood_tags_need_va_refresh(facts: &[crate::dto::TrackFactDto], content_hash: &str) -> bool {
    let expected = mood_tags_from_stored_facts(facts, content_hash, 2);
    if expected.is_empty() {
        return false;
    }
    let mut current: Vec<String> = facts
        .iter()
        .filter(|f| {
            f.fact_kind == "mood_tag"
                && f.source_kind == OXIMEDIA_ENRICHMENT_SOURCE_KIND
                && f.source_id
                    .starts_with(&format!("{OXIMEDIA_ENRICHMENT_SOURCE_ID}:"))
                && f.content_hash.as_deref() == Some(content_hash)
        })
        .filter_map(|f| f.value_text.clone())
        .collect();
    current.sort();
    let mut expected_sorted = expected;
    expected_sorted.sort();
    current != expected_sorted
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
        repo.put(server_id, track_id, &mood_tag_fact(tag, content_hash), now)?;
    }
    Ok(())
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

fn fact_current(facts: &[crate::dto::TrackFactDto], fact_kind: &str, content_hash: &str) -> bool {
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
            && f.source_id
                .starts_with(&format!("{OXIMEDIA_ENRICHMENT_SOURCE_ID}:"))
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
#[path = "enrichment/tests.rs"]
mod tests;
