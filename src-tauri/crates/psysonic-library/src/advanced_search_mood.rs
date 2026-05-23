//! Mood filter SQL for Advanced Search (`mood_group` / `mood_tag` clauses).

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::LibraryFilterClause;
use crate::filter::{self, FilterOp, SqlFragment};
use crate::mood_groups;

pub fn resolve_mood_clause(c: &LibraryFilterClause) -> Result<Option<SqlFragment>, String> {
    match c.field.as_str() {
        "mood_group" => {
            let group_ids = json_to_string_list(&c.field, c.op, c.value.as_ref())?;
            mood_groups::normalize_mood_groups(&group_ids).map_err(|detail| {
                filter::FilterError::BadValue {
                    field: c.field.clone(),
                    detail,
                }
                .to_string()
            })?;
            let tags = mood_groups::expand_mood_groups(&group_ids).map_err(|detail| {
                filter::FilterError::BadValue {
                    field: c.field.clone(),
                    detail,
                }
                .to_string()
            })?;
            Ok(Some(mood_tag_exists_fragment(&tags)))
        }
        "mood_tag" => {
            let tag_ids = json_to_string_list(&c.field, c.op, c.value.as_ref())?;
            let tags = mood_groups::normalize_mood_tags(&tag_ids).map_err(|detail| {
                filter::FilterError::BadValue {
                    field: c.field.clone(),
                    detail,
                }
                .to_string()
            })?;
            Ok(Some(mood_tag_exists_fragment(&tags)))
        }
        _ => unreachable!("resolve_mood_clause called for non-mood field"),
    }
}

fn mood_tag_exists_fragment(tags: &[String]) -> SqlFragment {
    let placeholders = (0..tags.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    SqlFragment {
        sql: format!(
            "EXISTS (SELECT 1 FROM track_fact mf \
             WHERE mf.server_id = t.server_id AND mf.track_id = t.id \
               AND mf.fact_kind = 'mood_tag' AND mf.value_text IN ({placeholders}))"
        ),
        params: tags
            .iter()
            .map(|t| SqlValue::Text(t.clone()))
            .collect(),
    }
}

fn json_to_string_list(
    field: &str,
    op: FilterOp,
    v: Option<&Value>,
) -> Result<Vec<String>, String> {
    match op {
        FilterOp::Eq => {
            let s = json_to_text(field, v)?;
            Ok(vec![match s {
                SqlValue::Text(t) => t,
                _ => unreachable!(),
            }])
        }
        FilterOp::In => match v {
            Some(Value::Array(items)) => {
                if items.is_empty() {
                    return Err(filter::FilterError::BadValue {
                        field: field.to_string(),
                        detail: "operator `in` requires a non-empty array".to_string(),
                    }
                    .to_string());
                }
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match item {
                        Value::String(s) => out.push(s.clone()),
                        _ => {
                            return Err(filter::FilterError::BadValue {
                                field: field.to_string(),
                                detail: "expected an array of strings".to_string(),
                            }
                            .to_string());
                        }
                    }
                }
                Ok(out)
            }
            _ => Err(filter::FilterError::BadValue {
                field: field.to_string(),
                detail: "operator `in` requires an array value".to_string(),
            }
            .to_string()),
        }
        _ => Err(filter::FilterError::UnsupportedOp {
            field: field.to_string(),
            op: op.as_str(),
        }
        .to_string()),
    }
}

fn json_to_text(field: &str, v: Option<&Value>) -> Result<SqlValue, String> {
    match v {
        Some(Value::String(s)) => Ok(SqlValue::Text(s.clone())),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected a string value".to_string(),
        }
        .to_string()),
    }
}
