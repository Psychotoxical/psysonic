use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackCursor {
    scope_key: String,
    positions: Vec<Option<TrackCursorPosition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct TrackCursorPosition {
    title: String,
    track_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct TrackCandidate {
    priority: usize,
    library_id: String,
    track: TrackRow,
    identity_key: Option<String>,
}

fn parse_track_cursor(
    cursor: Option<&str>,
    scopes: &[LibraryScopePair],
) -> Result<Option<TrackCursor>, String> {
    let Some(raw) = cursor else {
        return Ok(None);
    };
    let parsed: TrackCursor =
        serde_json::from_str(raw).map_err(|_| "invalid scope browse cursor")?;
    if parsed.scope_key != scope_key(scopes) || parsed.positions.len() != scopes.len() {
        return Err("scope browse cursor does not match the current scope".into());
    }
    Ok(Some(parsed))
}

fn track_cursor_position(candidate: &TrackCandidate) -> TrackCursorPosition {
    TrackCursorPosition {
        title: candidate.track.title.clone(),
        track_id: candidate.track.id.clone(),
    }
}

pub(super) fn query_track_scope_candidates(
    store: &LibraryStore,
    pair: &LibraryScopePair,
    priority: usize,
    cursor_position: Option<&TrackCursorPosition>,
    limit: usize,
) -> Result<Vec<TrackCandidate>, String> {
    let (seek, mut binds) = match cursor_position {
        Some(position) => (
            "AND (t.title COLLATE NOCASE > ? OR (t.title COLLATE NOCASE = ? AND t.id > ?))",
            vec![
                SqlValue::Text(position.title.clone()),
                SqlValue::Text(position.title.clone()),
                SqlValue::Text(position.track_id.clone()),
            ],
        ),
        None => ("", Vec::new()),
    };
    let columns = crate::search::aliased_track_columns("t");
    let library_filter = if pair.library_id.is_some() {
        " AND t.library_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {columns}, CASE WHEN ck.cluster_key IS NOT NULL \
         THEN {TRACK_CLUSTER_PARTITION_KEY} END \
         FROM track t \
         LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? {library_filter} AND t.deleted = 0 {seek} \
         ORDER BY t.title COLLATE NOCASE ASC, t.id ASC LIMIT ?",
    );
    let mut scope_binds = vec![SqlValue::Text(pair.server_id.clone())];
    if let Some(library_id) = &pair.library_id {
        scope_binds.push(SqlValue::Text(library_id.clone()));
    }
    binds.splice(0..0, scope_binds);
    binds.push(SqlValue::Integer(limit as i64));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                let track = row_to_track_row(row)?;
                Ok(TrackCandidate {
                    priority,
                    library_id: track.library_id.clone().unwrap_or_default(),
                    track,
                    identity_key: row.get(crate::search::track_projection_column_count())?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())
}

fn track_candidate_cmp(a: &TrackCandidate, b: &TrackCandidate) -> Ordering {
    a.track
        .title
        .to_lowercase()
        .cmp(&b.track.title.to_lowercase())
        .then_with(|| a.priority.cmp(&b.priority))
        .then_with(|| a.track.server_id.cmp(&b.track.server_id))
        .then_with(|| a.library_id.cmp(&b.library_id))
        .then_with(|| a.track.id.cmp(&b.track.id))
}

/// Resolve the highest-priority selected scope for every identity represented
/// in the candidate streams. This keeps cursor pages correct when the winner
/// was consumed on an earlier page, without doing an `EXISTS` query per row.
pub(super) fn track_identity_priorities(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    candidates: &[Vec<TrackCandidate>],
) -> Result<HashMap<String, usize>, String> {
    let identities = candidates
        .iter()
        .flatten()
        .filter_map(|candidate| candidate.identity_key.clone())
        .collect::<HashSet<_>>();
    if identities.is_empty() {
        return Ok(HashMap::new());
    }
    let (scope_cte, mut binds) = crate::scope_merge::scope_cte_sql(scopes);
    let placeholders = (0..identities.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "{scope_cte} SELECT {TRACK_CLUSTER_PARTITION_KEY}, MIN(scope.pr) \
         FROM scoped_track scope \
         INNER JOIN track t ON t.rowid = scope.rowid \
         INNER JOIN cluster.track_cluster_key ck \
           ON ck.server_id = t.server_id AND ck.track_id = t.id \
          WHERE t.deleted = 0 AND {TRACK_CLUSTER_PARTITION_KEY} IN ({placeholders}) \
          GROUP BY {TRACK_CLUSTER_PARTITION_KEY}",
    );
    binds.extend(identities.into_iter().map(SqlValue::Text));
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
            })?;
            rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(|error| error.to_string())
}

pub(super) fn browse_tracks(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    if !request.sort.is_empty() && request.sort.iter().any(|clause| clause.field != "title") {
        return Err("unsupported scope browse track sort".into());
    }
    let cursor = parse_track_cursor(request.cursor.as_deref(), &request.scopes)?;
    // Initial browse ensures a newly synced scope has identity rows. Cursor
    // pages reuse that prepared snapshot and must stay read-only hot paths.
    if cursor.is_none() {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &request.scopes)?;
    }
    let limit = request.limit.clamp(1, 200) as usize;
    let candidate_limit = CANDIDATE_PAGE_SIZE.max(limit.saturating_add(1));
    let mut candidates = Vec::with_capacity(request.scopes.len());
    let mut stream_exhausted = Vec::with_capacity(request.scopes.len());
    for (priority, scope) in request.scopes.iter().enumerate() {
        let stream = query_track_scope_candidates(
            store,
            scope,
            priority,
            cursor
                .as_ref()
                .and_then(|cursor| cursor.positions.get(priority))
                .and_then(Option::as_ref),
            candidate_limit,
        )?;
        stream_exhausted.push(stream.len() < candidate_limit);
        candidates.push(stream);
    }
    let mut identity_priorities = track_identity_priorities(store, &request.scopes, &candidates)?;

    let mut tracks = Vec::with_capacity(limit);
    let mut offsets = vec![0usize; candidates.len()];
    let mut positions = cursor
        .map(|cursor| cursor.positions)
        .unwrap_or_else(|| vec![None; request.scopes.len()]);
    while tracks.len() < limit {
        for scope_index in 0..candidates.len() {
            if offsets[scope_index] < candidates[scope_index].len() || stream_exhausted[scope_index]
            {
                continue;
            }
            let stream = query_track_scope_candidates(
                store,
                &request.scopes[scope_index],
                scope_index,
                positions[scope_index].as_ref(),
                candidate_limit,
            )?;
            stream_exhausted[scope_index] = stream.len() < candidate_limit;
            candidates[scope_index] = stream;
            offsets[scope_index] = 0;
            identity_priorities = track_identity_priorities(store, &request.scopes, &candidates)?;
        }
        let next_scope = candidates
            .iter()
            .enumerate()
            .filter(|(index, stream)| offsets[*index] < stream.len())
            .min_by(|(left_index, left_stream), (right_index, right_stream)| {
                track_candidate_cmp(
                    &left_stream[offsets[*left_index]],
                    &right_stream[offsets[*right_index]],
                )
            })
            .map(|(index, _)| index);
        let Some(scope_index) = next_scope else {
            break;
        };
        let candidate = &candidates[scope_index][offsets[scope_index]];
        offsets[scope_index] += 1;
        positions[scope_index] = Some(track_cursor_position(candidate));
        if let Some(identity_key) = candidate.identity_key.as_deref() {
            if identity_priorities
                .get(identity_key)
                .is_some_and(|priority| *priority < candidate.priority)
            {
                continue;
            }
        }
        tracks.push(LibraryTrackDto::from_row(&candidate.track));
    }
    let has_more = candidates
        .iter()
        .enumerate()
        .any(|(index, stream)| offsets[index] < stream.len() || !stream_exhausted[index]);
    let next_cursor = has_more.then(|| {
        serde_json::to_string(&TrackCursor {
            scope_key: scope_key(&request.scopes),
            positions,
        })
        .expect("scope browse cursor serializes")
    });
    Ok(LibraryScopeBrowseResponse {
        albums: Vec::new(),
        artists: Vec::new(),
        tracks,
        next_cursor,
        has_more,
        source: "local".into(),
    })
}
