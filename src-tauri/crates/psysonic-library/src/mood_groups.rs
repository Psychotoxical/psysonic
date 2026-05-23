//! Virtual mood groups and atomic mood tags for Advanced Search.
//!
//! Tracks store **atomic tags** in `track_fact` (`fact_kind = mood_tag`).
//! Product groups (joy, dance, …) are a static catalog only — each group
//! lists tag ids; search expands a group to `mood_tag IN (…)` with OR
//! semantics. Groups **may overlap** on purpose (e.g. joy and dance both
//! include `happy`). New tags can be added to the catalog without schema
//! changes.

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
}
