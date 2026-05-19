//! `FilterFieldRegistry` — Rust source of truth for Advanced Search filter
//! fields (spec §5.13.3 / P38). The full SQL builder (`AdvancedSearchQuery`,
//! §5.13.5) and the Tauri command surface (§5.13.6) come later; PR-1a
//! ships the registry shape + the v1 fields + the entity-routing rule.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntityKind {
    Track,
    Album,
    Artist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FilterOp {
    /// FTS5 MATCH (`track_fts`). Only valid on the `text` field in v1.
    Fts,
    Eq,
    /// Membership test against a list of values. (Not yet in v1; reserved.)
    In,
    Gte,
    Lte,
    Between,
    /// Boolean field — value side is ignored, presence = `IS NOT NULL`.
    IsTrue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FilterStatus {
    /// v1: built into the SQL builder and exercised by parity tests.
    V1,
    /// Schema present, builder hook to come post-v1.
    SchemaV1UiLater,
    /// Reserved column / planned-but-not-built.
    Planned,
    /// Out of scope for v1 entirely.
    Future,
}

#[derive(Debug, Clone, Copy)]
pub struct FilterField {
    pub id: &'static str,
    pub entities: &'static [EntityKind],
    pub ops: &'static [FilterOp],
    pub status: FilterStatus,
}

/// Static v1 registry. Adding a row here is the only thing required to expose
/// a new filter field (plus, when the storage isn't yet a hot column / index,
/// a separate `00X_*.sql` migration — see §5.7). No new invoke is needed.
pub const FILTER_FIELD_REGISTRY: &[FilterField] = &[
    FilterField {
        id: "text",
        entities: &[EntityKind::Track, EntityKind::Album, EntityKind::Artist],
        ops: &[FilterOp::Fts],
        status: FilterStatus::V1,
    },
    FilterField {
        id: "genre",
        entities: &[EntityKind::Track, EntityKind::Album],
        ops: &[FilterOp::Eq],
        status: FilterStatus::V1,
    },
    FilterField {
        id: "year",
        entities: &[EntityKind::Track, EntityKind::Album],
        ops: &[FilterOp::Gte, FilterOp::Lte, FilterOp::Between],
        status: FilterStatus::V1,
    },
    FilterField {
        id: "starred",
        entities: &[EntityKind::Track, EntityKind::Album, EntityKind::Artist],
        ops: &[FilterOp::IsTrue],
        status: FilterStatus::V1,
    },
    FilterField {
        id: "user_rating",
        entities: &[EntityKind::Track],
        ops: &[FilterOp::Gte, FilterOp::Eq],
        status: FilterStatus::Planned,
    },
    FilterField {
        id: "suffix",
        entities: &[EntityKind::Track],
        ops: &[FilterOp::Eq, FilterOp::In],
        status: FilterStatus::Planned,
    },
    FilterField {
        id: "bit_rate",
        entities: &[EntityKind::Track],
        ops: &[FilterOp::Gte, FilterOp::Lte, FilterOp::Between],
        status: FilterStatus::Planned,
    },
    FilterField {
        id: "bpm",
        entities: &[EntityKind::Track],
        ops: &[FilterOp::Gte, FilterOp::Lte, FilterOp::Between],
        status: FilterStatus::SchemaV1UiLater,
    },
];

pub fn lookup(id: &str) -> Option<&'static FilterField> {
    FILTER_FIELD_REGISTRY.iter().find(|f| f.id == id)
}

/// `true` when this filter field is applicable for a request that targets
/// the given entity. Per §5.13.3 the routing rule is a *skip*, not an error:
/// if the request asks for `entityTypes = [album, artist]` and a clause names
/// a track-only field, the clause is silently dropped.
pub fn applies_to(field: &FilterField, entity: EntityKind) -> bool {
    field.entities.contains(&entity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_all_v1_fields() {
        for id in ["text", "genre", "year", "starred"] {
            let f = lookup(id).unwrap_or_else(|| panic!("missing v1 field `{id}`"));
            assert_eq!(f.status, FilterStatus::V1, "`{id}` must be V1");
        }
    }

    #[test]
    fn bpm_is_schema_v1_but_ui_later() {
        // §5.13.3: bpm has a hot column + index from day one, but is hidden
        // from the v1 UI until §5.13.4 dual-storage resolution lands.
        assert_eq!(lookup("bpm").unwrap().status, FilterStatus::SchemaV1UiLater);
    }

    #[test]
    fn text_routes_to_all_three_entities() {
        let f = lookup("text").unwrap();
        assert!(applies_to(f, EntityKind::Track));
        assert!(applies_to(f, EntityKind::Album));
        assert!(applies_to(f, EntityKind::Artist));
    }

    #[test]
    fn track_only_field_is_skipped_for_album_entity() {
        let f = lookup("user_rating").unwrap();
        assert!(applies_to(f, EntityKind::Track));
        assert!(!applies_to(f, EntityKind::Album));
        assert!(!applies_to(f, EntityKind::Artist));
    }

    #[test]
    fn unknown_field_lookup_returns_none() {
        assert!(lookup("nope").is_none());
    }

    #[test]
    fn registry_has_no_duplicate_ids() {
        let mut ids: Vec<&str> = FILTER_FIELD_REGISTRY.iter().map(|f| f.id).collect();
        ids.sort();
        let len_before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), len_before, "duplicate filter field id detected");
    }
}
