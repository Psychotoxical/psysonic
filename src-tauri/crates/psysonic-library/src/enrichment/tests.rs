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
fn plan_requests_bpm_only_while_mood_analysis_disabled() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
    assert!(plan.need_bpm);
    assert!(!plan.need_valence && !plan.need_arousal && !plan.need_moods);
}

#[test]
fn plan_skips_current_hash_only() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    put_analysis_fact(&store, "bpm", "abc", Some(120), None, None);
    let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
    assert!(!plan.need_bpm);
    assert!(!plan.need_valence && !plan.need_arousal && !plan.need_moods);
    let plan2 = plan_track_enrichment(&store, "s1", "t1", "def", 2).unwrap();
    assert!(plan2.need_bpm);
}

#[test]
fn plan_skips_mood_analysis_while_oximedia_mood_disabled() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
    assert!(plan.need_bpm);
    assert!(!plan.need_valence && !plan.need_arousal && !plan.need_moods);
}

#[test]
#[ignore = "re-enable with OXIMEDIA_MOOD_TAGS_ENABLED"]
fn plan_refreshes_stale_quadrant_mood_tags_when_valence_arousal_present() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    put_analysis_fact(
        &store,
        "moods",
        "abc",
        None,
        None,
        Some(r#"{"happy":0.9,"excited":0.8}"#),
    );
    put_analysis_fact(&store, "valence", "abc", None, Some(0.55), None);
    put_analysis_fact(&store, "arousal", "abc", None, Some(0.42), None);
    let repo = FactRepository::new(&store);
    for tag in ["happy", "excited"] {
        repo.put(
            "s1",
            "t1",
            &FactInputDto {
                fact_kind: "mood_tag".into(),
                value_text: Some(tag.into()),
                value_real: None,
                value_int: None,
                unit: None,
                source_kind: OXIMEDIA_ENRICHMENT_SOURCE_KIND.into(),
                source_id: mood_tag_source_id(tag),
                confidence: 1.0,
                content_hash: Some("abc".into()),
                expires_at: None,
            },
            1,
        )
        .unwrap();
    }
    let _ = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
    let tags: Vec<_> = repo
        .get("s1", "t1", &["mood_tag".into()], 3)
        .unwrap()
        .into_iter()
        .filter(|f| f.fact_kind == "mood_tag")
        .map(|f| f.value_text.unwrap_or_default())
        .collect();
    assert_ne!(tags, vec!["happy", "excited"]);
}

#[test]
#[ignore = "re-enable with OXIMEDIA_MOOD_TAGS_ENABLED"]
fn plan_backfills_mood_tags_from_valence_arousal_over_quadrant_moods_json() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    put_analysis_fact(
        &store,
        "moods",
        "abc",
        None,
        None,
        Some(r#"{"happy":0.9,"excited":0.8}"#),
    );
    put_analysis_fact(&store, "valence", "abc", None, Some(0.55), None);
    put_analysis_fact(&store, "arousal", "abc", None, Some(0.42), None);
    let plan = plan_track_enrichment(&store, "s1", "t1", "abc", 2).unwrap();
    assert!(!plan.need_moods);
    let repo = FactRepository::new(&store);
    let tags: Vec<_> = repo
        .get("s1", "t1", &["mood_tag".into()], 3)
        .unwrap()
        .into_iter()
        .filter(|f| f.fact_kind == "mood_tag")
        .map(|f| f.value_text.unwrap_or_default())
        .collect();
    assert_ne!(tags, vec!["happy", "excited"]);
    assert!(!tags.is_empty());
}

#[test]
#[ignore = "re-enable with OXIMEDIA_MOOD_TAGS_ENABLED"]
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
    assert_eq!(tags, vec!["calm"]);
}

#[test]
fn store_skips_mood_facts_while_oximedia_mood_disabled() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    let facts = TrackEnrichmentFacts {
        bpm: Some(TrackEnrichmentIntFact {
            value: 128,
            confidence: 0.9,
        }),
        valence: Some(TrackEnrichmentRealFact {
            value: 0.4,
            confidence: 1.0,
        }),
        arousal: Some(TrackEnrichmentRealFact {
            value: 0.75,
            confidence: 1.0,
        }),
        moods: Some(r#"{"happy":0.7,"excited":0.5}"#.into()),
    };
    store_track_enrichment_facts(&store, "s1", "t1", "abc", &facts, 10).unwrap();
    let repo = FactRepository::new(&store);
    let rows = repo.get("s1", "t1", &[], 20).unwrap();
    assert!(rows.iter().any(|r| r.fact_kind == "bpm"));
    assert!(!rows.iter().any(|r| {
        matches!(
            r.fact_kind.as_str(),
            "mood_tag" | "moods" | "valence" | "arousal" | "mood_labels"
        )
    }));
}

#[test]
#[ignore = "re-enable with OXIMEDIA_MOOD_TAGS_ENABLED"]
fn store_writes_mood_tag_rows_from_valence_arousal() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1");
    let facts = TrackEnrichmentFacts {
        bpm: None,
        valence: Some(TrackEnrichmentRealFact {
            value: 0.4,
            confidence: 1.0,
        }),
        arousal: Some(TrackEnrichmentRealFact {
            value: 0.75,
            confidence: 1.0,
        }),
        moods: Some(r#"{"happy":0.7,"excited":0.5}"#.into()),
    };
    store_track_enrichment_facts(&store, "s1", "t1", "abc", &facts, 10).unwrap();
    let repo = FactRepository::new(&store);
    let mood_tags: Vec<_> = repo
        .get("s1", "t1", &[], 20)
        .unwrap()
        .into_iter()
        .filter(|r| r.fact_kind == "mood_tag")
        .map(|r| r.value_text.as_deref().unwrap_or("").to_string())
        .collect();
    assert_ne!(mood_tags, vec!["happy", "excited"]);
    assert!(!mood_tags.is_empty());
}

#[test]
#[ignore = "re-enable with OXIMEDIA_MOOD_TAGS_ENABLED"]
fn store_writes_mood_tag_rows_from_moods_json_when_va_missing() {
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
    assert_eq!(mood_tags, vec!["happy"]);
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
    assert_eq!(rows.len(), 1);
    assert!(rows
        .iter()
        .any(|r| r.fact_kind == "bpm" && r.value_int == Some(128)));
    assert!(!rows.iter().any(|r| r.fact_kind == "valence"));
    assert!(!rows.iter().any(|r| r.fact_kind == "arousal"));
}
