use super::{
    BackgroundScheduler, PollStats, SchedulerTickReport, SyncError, SyncStateRepository,
    ERROR_RETRY_INTERVAL_MS, MAX_PERSISTED_ERROR_CHARS,
};

impl BackgroundScheduler<'_> {
    pub(super) fn finish_tick(
        &self,
        now_ms: i64,
        result: Result<SchedulerTickReport, SyncError>,
    ) -> Result<SchedulerTickReport, SyncError> {
        match result {
            Ok(report) => {
                if report.completed_delta() {
                    if let Err(storage_err) = self.clear_tick_error() {
                        let err = SyncError::Storage(storage_err);
                        self.record_tick_error(now_ms, &err);
                        return Err(err);
                    }
                }
                Ok(report)
            }
            Err(err) => {
                self.record_tick_error(now_ms, &err);
                Err(err)
            }
        }
    }

    fn clear_tick_error(&self) -> Result<(), String> {
        self.store.with_conn("scheduler.clear_error", |conn| {
            conn.execute(
                "UPDATE sync_state SET last_error = NULL \
                 WHERE server_id = ?1 AND library_scope = ?2",
                rusqlite::params![self.server_id, self.library_scope],
            )?;
            Ok(())
        })
    }

    fn record_tick_error(&self, now_ms: i64, err: &SyncError) {
        let rendered = err.to_string();
        let persisted: String = rendered.chars().take(MAX_PERSISTED_ERROR_CHARS).collect();
        crate::app_eprintln!(
            "[library-sync] scheduler tick failed server_id={} scope={}: {}",
            self.server_id,
            self.library_scope,
            rendered
        );
        let next_poll_at = now_ms.saturating_add(ERROR_RETRY_INTERVAL_MS);
        if let Err(storage_err) = self.store.with_conn("scheduler.record_error", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_error, next_poll_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   last_error = excluded.last_error, \
                   next_poll_at = excluded.next_poll_at",
                rusqlite::params![self.server_id, self.library_scope, persisted, next_poll_at],
            )?;
            Ok(())
        }) {
            crate::app_eprintln!(
                "[library-sync] scheduler error persistence failed server_id={} scope={}: {}",
                self.server_id,
                self.library_scope,
                storage_err
            );
        }
    }

    pub(super) fn load_poll_stats(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<PollStats, SyncError> {
        let raw = sync_state
            .get_poll_stats_json(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        match raw {
            None => Ok(PollStats::default()),
            Some(value) => {
                serde_json::from_value(value).map_err(|error| SyncError::Storage(error.to_string()))
            }
        }
    }

    pub(super) fn sync_pass_active(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<bool, SyncError> {
        if self.foreground_sync_job_active || self.store.bulk_ingest_active() {
            return Ok(true);
        }
        let phase = sync_state
            .get_sync_phase(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        Ok(matches!(
            phase.as_deref(),
            Some("initial_sync") | Some("probing")
        ))
    }

    pub(super) fn count_local_tracks(&self) -> Result<i64, SyncError> {
        crate::repos::TrackRepository::new(self.store)
            .count_live_tracks_in_scope(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)
    }
}
