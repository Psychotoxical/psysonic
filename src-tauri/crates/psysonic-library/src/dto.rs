//! Public DTOs the Tauri command surface returns. camelCase wire shape
//! per `src-tauri/CLAUDE.md`. PR-5a only defines what the read-only
//! commands need; PR-5b adds sync-progress / cancel-ack shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repos::TrackRow;
use crate::store::LibraryStore;

/// `library_get_status` payload — mirrors the `sync_state` row plus a
/// few derived counters from `track`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateDto {
    pub server_id: String,
    pub library_scope: String,
    #[serde(default)]
    pub sync_phase: String,
    #[serde(default)]
    pub capability_flags: u32,
    #[serde(default)]
    pub library_tier: String,
    pub last_full_sync_at: Option<i64>,
    pub last_delta_sync_at: Option<i64>,
    pub next_poll_at: Option<i64>,
    pub server_last_scan_iso: Option<String>,
    pub indexes_last_modified_ms: Option<i64>,
    pub artists_last_modified_ms: Option<i64>,
    pub local_track_count: Option<i64>,
    pub server_track_count: Option<i64>,
    pub last_error: Option<String>,
    /// `MAX(server_updated_at)` over local non-deleted tracks — the
    /// implicit "tracks watermark" the N1-delta uses.
    pub local_tracks_max_updated_ms: Option<i64>,
}

/// `library_get_track` / `library_search` row shape — flat projection
/// over `track`'s hot columns plus the raw JSON sub-tree. Frontend
/// re-assembles its own `LibraryTrack` shape from this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrackDto {
    // Ref
    pub server_id: String,
    pub id: String,
    pub content_hash: Option<String>,

    // Hot columns
    pub title: String,
    pub title_sort: Option<String>,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub album: String,
    pub album_id: Option<String>,
    pub album_artist: Option<String>,
    pub duration_sec: i64,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub suffix: Option<String>,
    pub bit_rate: Option<i64>,
    pub size_bytes: Option<i64>,
    pub cover_art_id: Option<String>,
    pub starred_at: Option<i64>,
    pub user_rating: Option<i64>,
    pub play_count: Option<i64>,
    pub played_at: Option<i64>,
    pub server_path: Option<String>,
    pub library_id: Option<String>,
    pub isrc: Option<String>,
    pub mbid_recording: Option<String>,
    pub bpm: Option<i64>,
    pub replay_gain_track_db: Option<f64>,
    pub replay_gain_album_db: Option<f64>,

    pub server_updated_at: Option<i64>,
    pub server_created_at: Option<i64>,
    pub synced_at: i64,

    /// Original Subsonic / Navidrome song JSON the sync engine stored.
    /// Frontend parses this lazily when it needs OpenSubsonic extras
    /// (contributors, replayGain detail, …).
    pub raw_json: Value,
}

impl LibraryTrackDto {
    pub fn from_row(row: &TrackRow) -> Self {
        let raw_json: Value = serde_json::from_str(&row.raw_json).unwrap_or(Value::Null);
        Self {
            server_id: row.server_id.clone(),
            id: row.id.clone(),
            content_hash: row.content_hash.clone(),
            title: row.title.clone(),
            title_sort: row.title_sort.clone(),
            artist: row.artist.clone(),
            artist_id: row.artist_id.clone(),
            album: row.album.clone(),
            album_id: row.album_id.clone(),
            album_artist: row.album_artist.clone(),
            duration_sec: row.duration_sec,
            track_number: row.track_number,
            disc_number: row.disc_number,
            year: row.year,
            genre: row.genre.clone(),
            suffix: row.suffix.clone(),
            bit_rate: row.bit_rate,
            size_bytes: row.size_bytes,
            cover_art_id: row.cover_art_id.clone(),
            starred_at: row.starred_at,
            user_rating: row.user_rating,
            play_count: row.play_count,
            played_at: row.played_at,
            server_path: row.server_path.clone(),
            library_id: row.library_id.clone(),
            isrc: row.isrc.clone(),
            mbid_recording: row.mbid_recording.clone(),
            bpm: row.bpm,
            replay_gain_track_db: row.replay_gain_track_db,
            replay_gain_album_db: row.replay_gain_album_db,
            server_updated_at: row.server_updated_at,
            server_created_at: row.server_created_at,
            synced_at: row.synced_at,
            raw_json,
        }
    }
}

/// `library_get_tracks_batch` / `library_search` envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTracksEnvelope {
    pub tracks: Vec<LibraryTrackDto>,
    pub total: u32,
}

/// `library_get_artifact` payload — one row of `track_artifact`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackArtifactDto {
    pub server_id: String,
    pub track_id: String,
    pub artifact_kind: String,
    pub format: String,
    pub source_kind: String,
    pub source_id: String,
    pub language: Option<String>,
    pub content_text: Option<String>,
    pub content_bytes: i64,
    pub not_found: bool,
    pub content_hash: Option<String>,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

/// `library_get_facts` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackFactDto {
    pub server_id: String,
    pub track_id: String,
    pub fact_kind: String,
    pub value_real: Option<f64>,
    pub value_int: Option<i64>,
    pub value_text: Option<String>,
    pub unit: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    pub confidence: f64,
    pub content_hash: Option<String>,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

/// `library_get_offline_path` outcome — either a path string or a
/// `missing` flag so the frontend can show a hint without polling.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePathDto {
    pub server_id: String,
    pub track_id: String,
    pub local_path: Option<String>,
    pub missing: bool,
}

/// Compact track reference used as input by `library_get_tracks_batch`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TrackRefDto {
    pub server_id: String,
    pub track_id: String,
    #[serde(default)]
    pub content_hash: Option<String>,
}

/// Read `MAX(server_updated_at)` for non-deleted tracks on this server
/// — used by `SyncStateDto` so callers can show "tracks watermark" in
/// Settings without a separate column.
pub fn local_tracks_max_updated_ms(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Option<i64>, String> {
    store
        .with_conn(|c| {
            c.query_row(
                "SELECT MAX(server_updated_at) FROM track \
                 WHERE server_id = ?1 AND deleted = 0",
                rusqlite::params![server_id],
                |row| row.get::<_, Option<i64>>(0),
            )
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::TrackRepository;

    fn sample_row() -> TrackRow {
        TrackRow {
            server_id: "s1".into(),
            id: "tr_1".into(),
            title: "Hello".into(),
            title_sort: None,
            artist: Some("World".into()),
            artist_id: Some("ar_1".into()),
            album: "An Album".into(),
            album_id: Some("al_1".into()),
            album_artist: Some("World".into()),
            duration_sec: 240,
            track_number: Some(3),
            disc_number: Some(1),
            year: Some(2024),
            genre: Some("Ambient".into()),
            suffix: Some("flac".into()),
            bit_rate: Some(1000),
            size_bytes: Some(32_000_000),
            cover_art_id: Some("cv_1".into()),
            starred_at: None,
            user_rating: None,
            play_count: Some(0),
            played_at: None,
            server_path: Some("/path/x.flac".into()),
            library_id: Some("1".into()),
            isrc: Some("USRC17607839".into()),
            mbid_recording: Some("mb-1".into()),
            bpm: Some(120),
            replay_gain_track_db: Some(-1.2),
            replay_gain_album_db: Some(-0.8),
            content_hash: Some("deadbeef".into()),
            server_updated_at: Some(1_700_000_000),
            server_created_at: Some(1_699_000_000),
            deleted: false,
            synced_at: 1_700_000_500,
            raw_json: r#"{"replayGain":{"trackGain":-1.2}}"#.into(),
        }
    }

    #[test]
    fn library_track_dto_serializes_field_names_camel_case() {
        let dto = LibraryTrackDto::from_row(&sample_row());
        let json = serde_json::to_value(&dto).unwrap();
        // Spot-check critical wire keys — IPC contract.
        for key in [
            "serverId",
            "contentHash",
            "albumArtist",
            "durationSec",
            "trackNumber",
            "discNumber",
            "coverArtId",
            "userRating",
            "playCount",
            "playedAt",
            "serverPath",
            "libraryId",
            "mbidRecording",
            "replayGainTrackDb",
            "replayGainAlbumDb",
            "serverUpdatedAt",
            "syncedAt",
            "rawJson",
        ] {
            assert!(
                json.get(key).is_some(),
                "expected camelCase key `{key}` in serialized DTO, got {json}"
            );
        }
    }

    #[test]
    fn library_track_dto_parses_raw_json_into_value() {
        let dto = LibraryTrackDto::from_row(&sample_row());
        let rg = dto
            .raw_json
            .get("replayGain")
            .and_then(|v| v.get("trackGain"))
            .and_then(|v| v.as_f64())
            .unwrap();
        assert!((rg - -1.2).abs() < 0.001);
    }

    #[test]
    fn library_track_dto_falls_back_to_null_on_invalid_raw_json() {
        let mut row = sample_row();
        row.raw_json = "{not valid json}".into();
        let dto = LibraryTrackDto::from_row(&row);
        assert!(dto.raw_json.is_null(), "invalid JSON must surface as Value::Null");
    }

    #[test]
    fn local_tracks_max_updated_returns_max_over_non_deleted_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let mut r1 = sample_row();
        r1.server_updated_at = Some(1_000);
        let mut r2 = sample_row();
        r2.id = "tr_2".into();
        r2.server_updated_at = Some(3_000);
        let mut r3 = sample_row();
        r3.id = "tr_3".into();
        r3.server_updated_at = Some(5_000);
        r3.deleted = true;
        repo.upsert_batch(&[r1, r2, r3]).unwrap();

        assert_eq!(
            local_tracks_max_updated_ms(&store, "s1").unwrap(),
            Some(3_000),
            "deleted rows must be excluded"
        );
    }

    #[test]
    fn track_ref_dto_roundtrips_through_json() {
        let r = TrackRefDto {
            server_id: "s1".into(),
            track_id: "tr_1".into(),
            content_hash: Some("h".into()),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json.get("serverId").and_then(|v| v.as_str()), Some("s1"));
        let back: TrackRefDto = serde_json::from_value(json).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn sync_state_dto_omits_null_optionals_cleanly() {
        let dto = SyncStateDto {
            server_id: "s1".into(),
            library_scope: "".into(),
            sync_phase: "idle".into(),
            capability_flags: 0,
            library_tier: "unknown".into(),
            last_full_sync_at: None,
            last_delta_sync_at: None,
            next_poll_at: None,
            server_last_scan_iso: None,
            indexes_last_modified_ms: None,
            artists_last_modified_ms: None,
            local_track_count: None,
            server_track_count: None,
            last_error: None,
            local_tracks_max_updated_ms: None,
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(
            json.get("syncPhase").and_then(|v| v.as_str()),
            Some("idle")
        );
        // `null` survives as JSON null, not omitted — explicit shape
        // for the WebView so it can distinguish "missing" from
        // "unset".
        assert!(json.get("lastFullSyncAt").unwrap().is_null());
    }
}
