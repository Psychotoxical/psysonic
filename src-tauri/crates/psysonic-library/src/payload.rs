//! `ProgressEvent` → Tauri event payload mapper. PR-5a ships the
//! transformation as a pure function so it's unit-testable without
//! Tauri / supervisor wiring; PR-5b plugs the mpsc receiver into
//! `AppHandle::emit("library:sync-progress", payload)`.

use serde::{Deserialize, Serialize};

use crate::sync::progress::ProgressEvent;

/// Wire shape for the `library:sync-progress` / `library:sync-idle`
/// Tauri events. Carries the `serverId` + `libraryScope` so the
/// frontend can demultiplex across multiple servers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncProgressPayload {
    pub server_id: String,
    pub library_scope: String,
    /// Discriminator: `"phase_changed"` / `"ingest_page"` /
    /// `"remapped"` / `"tombstoned"` / `"completed"` / `"error"`.
    pub kind: String,
    pub phase: Option<String>,
    pub ingested_total: Option<u32>,
    pub batch_count: Option<u32>,
    pub remapped_count: Option<u32>,
    pub tombstones_checked: Option<u32>,
    pub tombstones_deleted: Option<u32>,
    pub completed_kind: Option<String>,
    pub message: Option<String>,
    /// Per-batch ingest timings (S1 initial sync).
    pub ingest_metrics: Option<crate::sync::progress::IngestBatchMetrics>,
}

impl LibrarySyncProgressPayload {
    pub fn from_event(event: &ProgressEvent, server_id: &str, library_scope: &str) -> Self {
        let mut payload = Self {
            server_id: server_id.to_string(),
            library_scope: library_scope.to_string(),
            kind: String::new(),
            phase: None,
            ingested_total: None,
            batch_count: None,
            remapped_count: None,
            tombstones_checked: None,
            tombstones_deleted: None,
            completed_kind: None,
            message: None,
            ingest_metrics: None,
        };
        match event {
            ProgressEvent::PhaseChanged { phase } => {
                payload.kind = "phase_changed".into();
                payload.phase = Some(phase.clone());
            }
            ProgressEvent::IngestPage {
                ingested_total,
                batch_count,
                metrics,
            } => {
                payload.kind = "ingest_page".into();
                payload.ingested_total = Some(*ingested_total);
                payload.batch_count = Some(*batch_count);
                payload.ingest_metrics = metrics.clone();
            }
            ProgressEvent::Remapped { entries } => {
                payload.kind = "remapped".into();
                payload.remapped_count = Some(entries.len() as u32);
            }
            ProgressEvent::Tombstoned {
                deleted_count,
                checked_count,
            } => {
                payload.kind = "tombstoned".into();
                payload.tombstones_deleted = Some(*deleted_count);
                payload.tombstones_checked = Some(*checked_count);
            }
            ProgressEvent::Completed { kind } => {
                payload.kind = "completed".into();
                payload.completed_kind = Some(kind.clone());
            }
            ProgressEvent::Error { message } => {
                payload.kind = "error".into();
                payload.message = Some(message.clone());
            }
        }
        payload
    }

    /// Convenience constant for the event-name Tauri emits.
    pub const PROGRESS_EVENT_NAME: &'static str = "library:sync-progress";
    pub const IDLE_EVENT_NAME: &'static str = "library:sync-idle";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::RemapEntry;

    #[test]
    fn phase_changed_maps_to_phase_kind() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::PhaseChanged { phase: "ingest".into() },
            "s1",
            "",
        );
        assert_eq!(p.kind, "phase_changed");
        assert_eq!(p.phase.as_deref(), Some("ingest"));
        assert_eq!(p.server_id, "s1");
    }

    #[test]
    fn ingest_page_carries_total_and_batch_count() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::IngestPage {
                ingested_total: 2500,
                batch_count: 5,
                metrics: None,
            },
            "s1",
            "lib-1",
        );
        assert_eq!(p.kind, "ingest_page");
        assert_eq!(p.ingested_total, Some(2500));
        assert_eq!(p.batch_count, Some(5));
        assert_eq!(p.library_scope, "lib-1");
    }

    #[test]
    fn remapped_count_reflects_entries_length() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::Remapped {
                entries: vec![
                    RemapEntry {
                        server_id: "s1".into(),
                        old_id: "a".into(),
                        new_id: "b".into(),
                    },
                    RemapEntry {
                        server_id: "s1".into(),
                        old_id: "c".into(),
                        new_id: "d".into(),
                    },
                ],
            },
            "s1",
            "",
        );
        assert_eq!(p.kind, "remapped");
        assert_eq!(p.remapped_count, Some(2));
    }

    #[test]
    fn tombstoned_carries_checked_and_deleted() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::Tombstoned {
                deleted_count: 3,
                checked_count: 10,
            },
            "s1",
            "",
        );
        assert_eq!(p.kind, "tombstoned");
        assert_eq!(p.tombstones_deleted, Some(3));
        assert_eq!(p.tombstones_checked, Some(10));
    }

    #[test]
    fn completed_event_records_kind_string() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::Completed { kind: "initial_sync".into() },
            "s1",
            "",
        );
        assert_eq!(p.kind, "completed");
        assert_eq!(p.completed_kind.as_deref(), Some("initial_sync"));
    }

    #[test]
    fn error_event_records_message() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::Error { message: "timeout".into() },
            "s1",
            "",
        );
        assert_eq!(p.kind, "error");
        assert_eq!(p.message.as_deref(), Some("timeout"));
    }

    #[test]
    fn ingest_metrics_serialize_camel_case() {
        use crate::sync::progress::IngestBatchMetrics;

        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::IngestPage {
                ingested_total: 500,
                batch_count: 1,
                metrics: Some(IngestBatchMetrics {
                    offset: 4500,
                    strategy: "s1".into(),
                    fetch_ms: 120,
                    write_ms: 8,
                    lock_wait_ms: 0,
                    sql_exec_ms: 7,
                    persist_ms: 1,
                    row_count: 500,
                    bulk_ingest_active: true,
                }),
            },
            "s1",
            "",
        );
        let json = serde_json::to_value(&p).unwrap();
        let metrics = json.get("ingestMetrics").unwrap();
        assert_eq!(metrics.get("fetchMs").and_then(|v| v.as_u64()), Some(120));
        assert_eq!(metrics.get("lockWaitMs").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(metrics.get("bulkIngestActive").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn serialization_uses_camel_case_keys() {
        let p = LibrarySyncProgressPayload::from_event(
            &ProgressEvent::IngestPage {
                ingested_total: 1,
                batch_count: 1,
                metrics: None,
            },
            "s1",
            "",
        );
        let json = serde_json::to_value(&p).unwrap();
        for key in [
            "serverId",
            "libraryScope",
            "kind",
            "ingestedTotal",
            "batchCount",
        ] {
            assert!(json.get(key).is_some(), "missing camelCase key `{key}`");
        }
    }
}
