//! `FilterFieldRegistry` — Rust source of truth for Advanced Search filter
//! fields (spec §5.13.3 / P38). The full SQL builder (`AdvancedSearchQuery`,
//! §5.13.5) and the Tauri command surface (§5.13.6) come later; PR-1a
//! ships the registry shape + the v1 fields + the entity-routing rule.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Track,
    Album,
    Artist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

impl FilterOp {
    /// Wire spelling — matches the TypeScript `FilterOperator` union and the
    /// `FilterOp::from_wire` parser. Used in error messages too.
    pub fn as_str(self) -> &'static str {
        match self {
            FilterOp::Fts => "fts",
            FilterOp::Eq => "eq",
            FilterOp::In => "in",
            FilterOp::Gte => "gte",
            FilterOp::Lte => "lte",
            FilterOp::Between => "between",
            FilterOp::IsTrue => "is_true",
        }
    }

    /// Parse the wire operator. Spec §5.13.2 lists a few operators
    /// (`neq` / `contains` / `is_false`) the v1 builder doesn't implement
    /// yet — those return `None` so the caller can raise a clear error
    /// rather than silently dropping the clause.
    pub fn from_wire(wire: &str) -> Option<FilterOp> {
        match wire {
            "fts" => Some(FilterOp::Fts),
            "eq" => Some(FilterOp::Eq),
            "in" => Some(FilterOp::In),
            "gte" => Some(FilterOp::Gte),
            "lte" => Some(FilterOp::Lte),
            "between" => Some(FilterOp::Between),
            "is_true" => Some(FilterOp::IsTrue),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FilterStatus {
    /// v1: built into the SQL builder and exercised by parity tests.
    V1,
    /// Schema + SQL builder present (the request and registry accept it),
    /// but hidden from the v1 UI — see §5.13.4 (`bpm` dual-storage).
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

// ── SQL fragment resolution (§5.13.5) ─────────────────────────────────

/// A resolved WHERE-clause snippet plus the values it binds. The builder
/// appends fragments in order and binds their params left-to-right against
/// anonymous `?` placeholders (`params_from_iter`), so a fragment must keep
/// its `sql` placeholders and `params` in the same order.
///
/// `sql` only ever contains builder-supplied column expressions and literal
/// operators — never user input (spec §5.13.5: parameterised only).
#[derive(Debug, Clone, PartialEq)]
pub struct SqlFragment {
    pub sql: String,
    pub params: Vec<rusqlite::types::Value>,
}

/// Why a `LibraryFilterClause` could not be turned into SQL. Surfaced to the
/// command as a human-readable string; `UnknownField` carries the known-field
/// list for dev builds (§5.13.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterError {
    /// `field` is not in the registry at all (typo / wrong client).
    UnknownField(String),
    /// `field` is registered but has no v1 SQL builder yet (`user_rating`,
    /// `suffix`, `bit_rate`, …). Distinct from `UnknownField` so the caller
    /// can tell a typo from a planned-but-unbuilt field.
    NotQueryable(String),
    /// `op` is not declared for `field` in the registry.
    UnsupportedOp { field: String, op: &'static str },
    /// The value side was missing or the wrong type for the operator.
    BadValue { field: String, detail: String },
}

impl std::fmt::Display for FilterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FilterError::UnknownField(field) => {
                let known = FILTER_FIELD_REGISTRY
                    .iter()
                    .map(|x| x.id)
                    .collect::<Vec<_>>()
                    .join(", ");
                write!(f, "unknown filter field `{field}` (known: {known})")
            }
            FilterError::NotQueryable(field) => {
                write!(f, "filter field `{field}` is registered but not queryable in v1")
            }
            FilterError::UnsupportedOp { field, op } => {
                write!(f, "operator `{op}` is not supported for filter field `{field}`")
            }
            FilterError::BadValue { field, detail } => {
                write!(f, "bad value for filter field `{field}`: {detail}")
            }
        }
    }
}

/// Validate that `field` exists, applies to `entity`, and declares `op`.
///
/// Returns `Ok(true)` when the clause is applicable, `Ok(false)` when the
/// field is known but doesn't route to this entity (§5.13.3: skip, don't
/// error), and `Err` when the field is unknown or the op is undeclared.
pub fn validate_for_entity(
    field_id: &str,
    op: FilterOp,
    entity: EntityKind,
) -> Result<bool, FilterError> {
    let field = lookup(field_id).ok_or_else(|| FilterError::UnknownField(field_id.to_string()))?;
    if !field.ops.contains(&op) {
        return Err(FilterError::UnsupportedOp {
            field: field_id.to_string(),
            op: op.as_str(),
        });
    }
    Ok(applies_to(field, entity))
}

/// Build a comparison fragment for a builder-supplied column expression.
/// `col` is trusted SQL (never user input); only the bound values come from
/// the request. `eq`/`gte`/`lte`/`between` parameterise their operands;
/// `is_true` ignores the value and tests `IS NOT NULL`. `between` is
/// inclusive on both ends (matches the year UI — §5.13.5).
pub fn compare_fragment(
    field: &str,
    col: &str,
    op: FilterOp,
    value: Option<rusqlite::types::Value>,
    value_to: Option<rusqlite::types::Value>,
) -> Result<SqlFragment, FilterError> {
    let need_value = |v: Option<rusqlite::types::Value>| {
        v.ok_or_else(|| FilterError::BadValue {
            field: field.to_string(),
            detail: format!("operator `{}` requires a value", op.as_str()),
        })
    };
    match op {
        FilterOp::Eq => Ok(SqlFragment {
            sql: format!("{col} = ?"),
            params: vec![need_value(value)?],
        }),
        FilterOp::Gte => Ok(SqlFragment {
            sql: format!("{col} >= ?"),
            params: vec![need_value(value)?],
        }),
        FilterOp::Lte => Ok(SqlFragment {
            sql: format!("{col} <= ?"),
            params: vec![need_value(value)?],
        }),
        FilterOp::Between => {
            let lo = need_value(value)?;
            let hi = value_to.ok_or_else(|| FilterError::BadValue {
                field: field.to_string(),
                detail: "operator `between` requires `valueTo`".to_string(),
            })?;
            Ok(SqlFragment {
                sql: format!("{col} BETWEEN ? AND ?"),
                params: vec![lo, hi],
            })
        }
        FilterOp::IsTrue => Ok(SqlFragment {
            sql: format!("{col} IS NOT NULL"),
            params: vec![],
        }),
        FilterOp::Fts | FilterOp::In => Err(FilterError::UnsupportedOp {
            field: field.to_string(),
            op: op.as_str(),
        }),
    }
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

    // ── SQL fragment resolution ───────────────────────────────────────

    #[test]
    fn op_wire_roundtrips() {
        for op in [
            FilterOp::Fts,
            FilterOp::Eq,
            FilterOp::In,
            FilterOp::Gte,
            FilterOp::Lte,
            FilterOp::Between,
            FilterOp::IsTrue,
        ] {
            assert_eq!(FilterOp::from_wire(op.as_str()), Some(op));
        }
    }

    #[test]
    fn op_from_wire_rejects_unbuilt_operators() {
        // Spec §5.13.2 lists these but the v1 builder doesn't implement them.
        for wire in ["neq", "contains", "is_false", "nope"] {
            assert!(FilterOp::from_wire(wire).is_none(), "`{wire}` must not parse");
        }
    }

    #[test]
    fn validate_unknown_field_errors() {
        let err = validate_for_entity("nope", FilterOp::Eq, EntityKind::Track).unwrap_err();
        assert!(matches!(err, FilterError::UnknownField(f) if f == "nope"));
    }

    #[test]
    fn validate_undeclared_op_errors() {
        // `genre` only declares `eq` in v1.
        let err = validate_for_entity("genre", FilterOp::Gte, EntityKind::Track).unwrap_err();
        assert!(matches!(err, FilterError::UnsupportedOp { .. }));
    }

    #[test]
    fn validate_known_field_off_entity_is_skip_not_error() {
        // `bpm` is track-only — for an album query it routes to "skip".
        assert_eq!(
            validate_for_entity("bpm", FilterOp::Between, EntityKind::Album),
            Ok(false)
        );
        assert_eq!(
            validate_for_entity("bpm", FilterOp::Between, EntityKind::Track),
            Ok(true)
        );
    }

    #[test]
    fn compare_fragment_between_is_inclusive_both_ends() {
        use rusqlite::types::Value;
        let frag = compare_fragment(
            "year",
            "t.year",
            FilterOp::Between,
            Some(Value::Integer(2000)),
            Some(Value::Integer(2010)),
        )
        .unwrap();
        assert_eq!(frag.sql, "t.year BETWEEN ? AND ?");
        assert_eq!(frag.params, vec![Value::Integer(2000), Value::Integer(2010)]);
    }

    #[test]
    fn compare_fragment_between_without_value_to_errors() {
        use rusqlite::types::Value;
        let err = compare_fragment(
            "year",
            "t.year",
            FilterOp::Between,
            Some(Value::Integer(2000)),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, FilterError::BadValue { .. }));
    }

    #[test]
    fn compare_fragment_is_true_ignores_value() {
        let frag = compare_fragment("starred", "t.starred_at", FilterOp::IsTrue, None, None).unwrap();
        assert_eq!(frag.sql, "t.starred_at IS NOT NULL");
        assert!(frag.params.is_empty());
    }
}
