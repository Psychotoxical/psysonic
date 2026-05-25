//! Virtual mood groups and atomic mood tags for Advanced Search.
//!
//! Tracks store **atomic tags** in `track_fact` (`fact_kind = mood_tag`).
//! Product groups (joy, dance, …) are a static catalog only — each group
//! lists tag ids; search expands a group to `mood_tag IN (…)` with OR
//! semantics. Groups **may overlap** on purpose (e.g. joy and dance both
//! include `happy`). New tags can be added to the catalog without schema
//! changes.

use std::cmp::Ordering;
use std::collections::HashSet;

/// Oximedia `MoodDetector` label ids shipped today (mirrors TS catalog).
pub const OXIMEDIA_MOOD_TAG_IDS: &[&str] = &[
    "happy",
    "excited",
    "calm",
    "peaceful",
    "angry",
    "tense",
    "sad",
    "melancholic",
];

/// Product mood group ids (i18n: `search.moodGroups.*`).
pub const MOOD_GROUP_IDS: &[&str] = &["joy", "sadness", "dance", "work", "romance", "anger"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoodGroup {
    pub id: &'static str,
    pub tags: &'static [&'static str],
}

/// Virtual groups → atomic tags. Overlaps are intentional.
pub const MOOD_GROUPS: &[MoodGroup] = &[
    MoodGroup {
        id: "joy",
        tags: &["happy", "excited"],
    },
    MoodGroup {
        id: "sadness",
        tags: &["sad", "melancholic"],
    },
    MoodGroup {
        id: "dance",
        tags: &["excited", "happy", "tense", "angry"],
    },
    MoodGroup {
        id: "work",
        tags: &["calm", "peaceful"],
    },
    MoodGroup {
        id: "romance",
        tags: &["peaceful", "calm", "melancholic"],
    },
    MoodGroup {
        id: "anger",
        tags: &["angry", "tense"],
    },
];

pub fn is_oximedia_mood_tag(id: &str) -> bool {
    OXIMEDIA_MOOD_TAG_IDS.contains(&id)
}

pub fn is_valid_mood_group(id: &str) -> bool {
    MOOD_GROUP_IDS.contains(&id)
}

pub fn lookup_mood_group(id: &str) -> Option<&'static MoodGroup> {
    MOOD_GROUPS.iter().find(|g| g.id == id)
}

/// Known tag ids for filters / validation (oximedia + any catalog-only tags).
pub fn is_known_mood_tag(id: &str) -> bool {
    if is_oximedia_mood_tag(id) {
        return true;
    }
    MOOD_GROUPS.iter().any(|g| g.tags.contains(&id))
}

/// Expand virtual group ids to deduplicated atomic tag ids (stable order).
pub fn expand_mood_groups(group_ids: &[String]) -> Result<Vec<String>, String> {
    if group_ids.is_empty() {
        return Err("expected at least one mood group".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for gid in group_ids {
        let group = lookup_mood_group(gid)
            .ok_or_else(|| format!("unknown mood group `{gid}`"))?;
        for tag in group.tags {
            if !out.iter().any(|t| t == tag) {
                out.push((*tag).to_string());
            }
        }
    }
    Ok(out)
}

/// Validate mood-group ids for `mood_group` filters (`eq` / `in`).
pub fn normalize_mood_groups(group_ids: &[String]) -> Result<Vec<String>, String> {
    if group_ids.is_empty() {
        return Err("expected at least one mood group".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for id in group_ids {
        if !is_valid_mood_group(id) {
            return Err(format!("unknown mood group `{id}`"));
        }
        if !out.iter().any(|g| g == id) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

/// Valence/arousal anchor in normalized mood space (see `mood_scores_from_valence_arousal`).
struct MoodVaAnchor {
    id: &'static str,
    v: f64,
    a: f64,
}

const MOOD_VA_ANCHORS: &[MoodVaAnchor] = &[
    MoodVaAnchor { id: "happy", v: 0.75, a: 0.72 },
    MoodVaAnchor { id: "excited", v: 0.55, a: 0.88 },
    MoodVaAnchor { id: "calm", v: 0.65, a: 0.22 },
    MoodVaAnchor { id: "peaceful", v: 0.78, a: 0.12 },
    MoodVaAnchor { id: "angry", v: -0.72, a: 0.82 },
    MoodVaAnchor { id: "tense", v: -0.35, a: 0.68 },
    MoodVaAnchor { id: "sad", v: -0.75, a: 0.28 },
    MoodVaAnchor { id: "melancholic", v: -0.55, a: 0.18 },
];

const MOOD_VA_MAX_DIST: f64 = 1.35;
const MOOD_VA_VALENCE_BIAS: f64 = 0.12;
const MOOD_VA_VALENCE_SCALE: f64 = 1.4;
const MOOD_VA_AROUSAL_OFFSET: f64 = 0.48;
const MOOD_VA_AROUSAL_SCALE: f64 = 0.40;
const MOOD_DISPLAY_MIN_RELATIVE: f64 = 0.55;
const MOOD_DISPLAY_MIN_ABSOLUTE: f64 = 0.28;

/// Pairs shown as one mood in UI/search tags — never both `happy` and `excited`.
const MOOD_DISPLAY_CLUSTERS: &[&[&str]] = &[
    &["happy", "excited"],
    &["calm", "peaceful"],
    &["angry", "tense"],
    &["sad", "melancholic"],
];

fn mood_display_cluster(tag: &str) -> Option<usize> {
    MOOD_DISPLAY_CLUSTERS
        .iter()
        .position(|cluster| cluster.contains(&tag))
}

/// Soft scores for all oximedia mood tags from raw valence/arousal.
///
/// Oximedia's built-in `map_to_moods` uses hard quadrant cutoffs and returns
/// only two labels (usually `happy` + `excited` for typical pop/rock). We
/// recalibrate V/A and score every catalog tag by distance to anchor points.
pub fn mood_scores_from_valence_arousal(valence: f64, arousal: f64) -> Vec<(String, f64)> {
    let v = ((valence - MOOD_VA_VALENCE_BIAS) * MOOD_VA_VALENCE_SCALE).clamp(-1.0, 1.0);
    let a = ((arousal - MOOD_VA_AROUSAL_OFFSET) / MOOD_VA_AROUSAL_SCALE).clamp(0.0, 1.0);
    MOOD_VA_ANCHORS
        .iter()
        .map(|anchor| {
            let dv = v - anchor.v;
            let da = a - anchor.a;
            let dist = (dv * dv + da * da).sqrt();
            let score = (1.0 - dist / MOOD_VA_MAX_DIST).max(0.0);
            (anchor.id.to_string(), score)
        })
        .collect()
}

pub fn top_distinct_oximedia_mood_tag_ids_from_scores(
    scores: &[(String, f64)],
    limit: usize,
) -> Vec<String> {
    let mut scored = scores.to_vec();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored.retain(|(k, _)| is_oximedia_mood_tag(k));
    let top_score = scored.first().map(|(_, s)| *s).unwrap_or(0.0);
    let mut out = Vec::new();
    let mut used_clusters = HashSet::new();
    for (tag, score) in scored {
        if score < MOOD_DISPLAY_MIN_ABSOLUTE || score < top_score * MOOD_DISPLAY_MIN_RELATIVE {
            continue;
        }
        if let Some(cluster) = mood_display_cluster(&tag) {
            if !used_clusters.insert(cluster) {
                continue;
            }
        }
        out.push(tag);
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn top_distinct_oximedia_mood_tag_ids_from_moods_json(json: &str, limit: usize) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(obj) = parsed.as_object() else {
        return Vec::new();
    };
    let scores: Vec<(String, f64)> = obj
        .iter()
        .filter_map(|(k, v)| v.as_f64().map(|score| (k.clone(), score)))
        .collect();
    top_distinct_oximedia_mood_tag_ids_from_scores(&scores, limit)
}

pub fn top_mood_tag_ids_from_valence_arousal(
    valence: f64,
    arousal: f64,
    limit: usize,
) -> Vec<String> {
    top_distinct_oximedia_mood_tag_ids_from_scores(
        &mood_scores_from_valence_arousal(valence, arousal),
        limit,
    )
}

/// Top oximedia mood tag ids by score (filter unknown labels first, then sort
/// by score desc, id asc). Mirrors TS `topOximediaMoodTagIds`.
pub fn top_oximedia_mood_tag_ids_from_moods_json(json: &str, limit: usize) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(obj) = parsed.as_object() else {
        return Vec::new();
    };
    let scores: Vec<(String, f64)> = obj
        .iter()
        .filter_map(|(k, v)| v.as_f64().map(|score| (k.clone(), score)))
        .collect();
    top_oximedia_mood_tag_ids_from_scores(&scores, limit)
}

pub fn top_oximedia_mood_tag_ids_from_scores(
    scores: &[(String, f64)],
    limit: usize,
) -> Vec<String> {
    let mut scored = scores.to_vec();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored
        .into_iter()
        .filter(|(k, _)| is_oximedia_mood_tag(k))
        .take(limit)
        .map(|(k, _)| k)
        .collect()
}

/// Validate atomic mood-tag ids for direct `mood_tag` filters.
pub fn normalize_mood_tags(tag_ids: &[String]) -> Result<Vec<String>, String> {
    if tag_ids.is_empty() {
        return Err("expected at least one mood tag".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for id in tag_ids {
        if !is_known_mood_tag(id) {
            return Err(format!("unknown mood tag `{id}`"));
        }
        if !out.iter().any(|t| t == id) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joy_expands_to_happy_and_excited() {
        assert_eq!(
            expand_mood_groups(&["joy".into()]).unwrap(),
            vec!["happy", "excited"]
        );
    }

    #[test]
    fn groups_overlap_by_design() {
        let joy = expand_mood_groups(&["joy".into()]).unwrap();
        let dance = expand_mood_groups(&["dance".into()]).unwrap();
        assert!(joy.iter().any(|t| dance.contains(t)));
        let work = expand_mood_groups(&["work".into()]).unwrap();
        let romance = expand_mood_groups(&["romance".into()]).unwrap();
        assert!(work.iter().any(|t| romance.contains(t)));
    }

    #[test]
    fn all_oximedia_tags_appear_in_at_least_one_group() {
        for tag in OXIMEDIA_MOOD_TAG_IDS {
            assert!(
                MOOD_GROUPS.iter().any(|g| g.tags.contains(tag)),
                "oximedia tag `{tag}` must appear in a virtual group"
            );
        }
    }

    #[test]
    fn anger_expands_to_q3_tags() {
        assert_eq!(
            expand_mood_groups(&["anger".into()]).unwrap(),
            vec!["angry", "tense"]
        );
    }

    #[test]
    fn unknown_group_errors() {
        assert!(expand_mood_groups(&["nope".into()]).is_err());
    }

    #[test]
    fn top_mood_tags_ignore_unknown_labels_before_limit() {
        let json = r#"{"noise":0.99,"calm":0.2,"happy":0.9,"excited":0.5}"#;
        assert_eq!(
            top_oximedia_mood_tag_ids_from_moods_json(json, 3),
            vec!["happy", "excited", "calm"]
        );
    }

    #[test]
    fn valence_arousal_never_returns_both_happy_and_excited() {
        let tags = top_mood_tag_ids_from_valence_arousal(0.4, 0.75, 2);
        assert!(
            !(tags.contains(&"happy".to_string()) && tags.contains(&"excited".to_string())),
            "got {tags:?}"
        );
        assert_eq!(tags.len(), 2);
    }

    #[test]
    fn valence_arousal_soft_scores_differ_from_quadrant_happy_excited() {
        let tags = top_mood_tag_ids_from_valence_arousal(0.4, 0.75, 2);
        assert_ne!(tags, vec!["happy", "excited"]);
    }

    #[test]
    fn low_arousal_prefers_calm_or_peaceful() {
        let tags = top_mood_tag_ids_from_valence_arousal(0.55, 0.42, 2);
        assert!(
            tags.iter().any(|t| t == "calm" || t == "peaceful"),
            "got {tags:?}"
        );
    }

    #[test]
    fn negative_valence_high_arousal_prefers_anger_quadrant() {
        let tags = top_mood_tag_ids_from_valence_arousal(-0.45, 0.82, 2);
        assert!(
            tags.iter().any(|t| t == "angry" || t == "tense"),
            "got {tags:?}"
        );
    }
}
