//! Oximedia mood tags and UI/search mood groups (static catalog).
//!
//! Tracks store **atomic tags** in `track_fact` (`fact_kind = mood_tag`).
//! Product mood groups (Радость, Грусть, …) map to oximedia tags here —
//! never stored on the track row.

/// Oximedia `MoodDetector` label ids (mirrors `src/config/moodGroups.ts`).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoodGroup {
    pub id: &'static str,
    pub tags: &'static [&'static str],
}

/// Product mood groups for Advanced Search — each expands to oximedia tags.
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
        tags: &["excited", "tense", "happy", "angry"],
    },
    MoodGroup {
        id: "work",
        tags: &["calm", "peaceful"],
    },
    MoodGroup {
        id: "romance",
        tags: &["peaceful", "calm", "melancholic"],
    },
];

pub fn is_valid_mood_tag(id: &str) -> bool {
    OXIMEDIA_MOOD_TAG_IDS.contains(&id)
}

pub fn lookup_mood_group(id: &str) -> Option<&'static MoodGroup> {
    MOOD_GROUPS.iter().find(|g| g.id == id)
}

/// Expand mood-group ids to deduplicated atomic tag ids (stable order).
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

/// Validate atomic mood-tag ids for direct `mood_tag` filters.
pub fn normalize_mood_tags(tag_ids: &[String]) -> Result<Vec<String>, String> {
    if tag_ids.is_empty() {
        return Err("expected at least one mood tag".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for id in tag_ids {
        if !is_valid_mood_tag(id) {
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
        let tags = expand_mood_groups(&["joy".into()]).unwrap();
        assert_eq!(tags, vec!["happy", "excited"]);
    }

    #[test]
    fn dance_includes_high_energy_tags() {
        let tags = expand_mood_groups(&["dance".into()]).unwrap();
        assert!(tags.contains(&"excited".to_string()));
        assert!(tags.contains(&"tense".to_string()));
    }

    #[test]
    fn multiple_groups_deduplicate_tags() {
        let tags = expand_mood_groups(&["joy".into(), "dance".into()]).unwrap();
        assert_eq!(tags.iter().filter(|t| *t == "happy").count(), 1);
        assert_eq!(tags.iter().filter(|t| *t == "excited").count(), 1);
    }

    #[test]
    fn unknown_group_errors() {
        assert!(expand_mood_groups(&["cheerful".into()]).is_err());
    }

    #[test]
    fn normalize_rejects_unknown_tag() {
        assert!(normalize_mood_tags(&["happy".into(), "nope".into()]).is_err());
    }
}
