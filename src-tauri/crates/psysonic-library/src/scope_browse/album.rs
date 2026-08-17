use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AlbumSort {
    Name,
    Artist,
    ArtistYear,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AlbumCursor {
    scope_key: String,
    sort: AlbumSort,
    positions: Vec<Option<AlbumCursorPosition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AlbumCursorPosition {
    name: String,
    artist: String,
    year: i64,
    album_id: String,
}

#[derive(Debug, Clone)]
struct AlbumCandidate {
    priority: usize,
    server_id: String,
    library_id: String,
    album_id: String,
    identity_key: Option<String>,
    name: String,
    artist: Option<String>,
    artist_id: Option<String>,
    song_count: i64,
    duration_sec: i64,
    year: Option<i64>,
    genre: Option<String>,
    cover_art_id: Option<String>,
    starred_at: Option<i64>,
    synced_at: i64,
}

fn album_sort(sort: &[LibrarySortClause]) -> Result<AlbumSort, String> {
    let fields: Vec<&str> = sort.iter().map(|clause| clause.field.as_str()).collect();
    match fields.as_slice() {
        [] | ["name"] | ["name", "artist"] => Ok(AlbumSort::Name),
        ["artist"] | ["artist", "name"] => Ok(AlbumSort::Artist),
        ["artist", "year"] | ["artist", "year", "name"] => Ok(AlbumSort::ArtistYear),
        _ => Err("unsupported scope browse album sort".into()),
    }
}

fn order_sql(sort: AlbumSort) -> &'static str {
    match sort {
        AlbumSort::Name => {
            "name COLLATE NOCASE ASC, COALESCE(artist, '') COLLATE NOCASE ASC, album_id ASC"
        }
        AlbumSort::Artist => {
            "COALESCE(artist, '') COLLATE NOCASE ASC, name COLLATE NOCASE ASC, album_id ASC"
        }
        AlbumSort::ArtistYear => {
            "COALESCE(artist, '') COLLATE NOCASE ASC, COALESCE(year, 0) ASC, name COLLATE NOCASE ASC, album_id ASC"
        }
    }
}

fn candidate_cmp(sort: AlbumSort, a: &AlbumCandidate, b: &AlbumCandidate) -> Ordering {
    let fold = |value: &str| value.to_lowercase();
    let by_name = || fold(&a.name).cmp(&fold(&b.name));
    let by_artist =
        || fold(a.artist.as_deref().unwrap_or("")).cmp(&fold(b.artist.as_deref().unwrap_or("")));
    let order = match sort {
        AlbumSort::Name => by_name().then_with(by_artist),
        AlbumSort::Artist => by_artist().then_with(by_name),
        AlbumSort::ArtistYear => by_artist()
            .then_with(|| a.year.unwrap_or(0).cmp(&b.year.unwrap_or(0)))
            .then_with(by_name),
    };
    order
        .then_with(|| a.priority.cmp(&b.priority))
        .then_with(|| a.server_id.cmp(&b.server_id))
        .then_with(|| a.library_id.cmp(&b.library_id))
        .then_with(|| a.album_id.cmp(&b.album_id))
}

fn candidate_to_dto(candidate: AlbumCandidate) -> LibraryAlbumDto {
    LibraryAlbumDto {
        server_id: candidate.server_id,
        id: candidate.album_id,
        name: candidate.name,
        artist: candidate.artist,
        artist_id: candidate.artist_id,
        song_count: Some(candidate.song_count),
        duration_sec: Some(candidate.duration_sec),
        year: candidate.year,
        genre: candidate.genre,
        cover_art_id: candidate.cover_art_id,
        starred_at: candidate.starred_at,
        synced_at: candidate.synced_at,
        raw_json: serde_json::Value::Null,
    }
}

fn parse_cursor(
    cursor: Option<&str>,
    scopes: &[LibraryScopePair],
    sort: AlbumSort,
) -> Result<Option<AlbumCursor>, String> {
    let Some(raw) = cursor else {
        return Ok(None);
    };
    let parsed: AlbumCursor =
        serde_json::from_str(raw).map_err(|_| "invalid scope browse cursor")?;
    if parsed.scope_key != scope_key(scopes)
        || parsed.sort != sort
        || parsed.positions.len() != scopes.len()
    {
        return Err("scope browse cursor does not match the current scope or sort".into());
    }
    Ok(Some(parsed))
}

fn cursor_position(candidate: &AlbumCandidate) -> AlbumCursorPosition {
    AlbumCursorPosition {
        name: candidate.name.clone(),
        artist: candidate.artist.clone().unwrap_or_default(),
        year: candidate.year.unwrap_or(0),
        album_id: candidate.album_id.clone(),
    }
}

fn seek_sql(sort: AlbumSort, position: Option<&AlbumCursorPosition>) -> (String, Vec<SqlValue>) {
    let Some(position) = position else {
        return (String::new(), Vec::new());
    };
    match sort {
        AlbumSort::Name => (
            "AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND album_id > ?))))".into(),
            vec![
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
        AlbumSort::Artist => (
            "AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND album_id > ?))))".into(),
            vec![
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
        AlbumSort::ArtistYear => (
            "AND (COALESCE(artist, '') COLLATE NOCASE > ? OR (COALESCE(artist, '') COLLATE NOCASE = ? AND (COALESCE(year, 0) > ? OR (COALESCE(year, 0) = ? AND (name COLLATE NOCASE > ? OR (name COLLATE NOCASE = ? AND album_id > ?))))))".into(),
            vec![
                SqlValue::Text(position.artist.clone()),
                SqlValue::Text(position.artist.clone()),
                SqlValue::Integer(position.year),
                SqlValue::Integer(position.year),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.name.clone()),
                SqlValue::Text(position.album_id.clone()),
            ],
        ),
    }
}

fn query_scope_candidates(
    store: &LibraryStore,
    pair: &LibraryScopePair,
    priority: usize,
    sort: AlbumSort,
    cursor_position: Option<&AlbumCursorPosition>,
    limit: usize,
) -> Result<Vec<AlbumCandidate>, String> {
    let (seek, mut binds) = seek_sql(sort, cursor_position);
    let library_filter = if pair.library_id.is_some() {
        " AND library_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT server_id, library_id, album_id, identity_key, name, artist, artist_id, song_count, \
                 duration_sec, year, genre, cover_art_id, starred_at, synced_at \
         FROM album_browse_projection \
         WHERE server_id = ? {library_filter} {seek} \
         ORDER BY {} LIMIT ?",
        order_sql(sort),
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
                Ok(AlbumCandidate {
                    priority,
                    server_id: row.get(0)?,
                    library_id: row.get(1)?,
                    album_id: row.get(2)?,
                    identity_key: row.get(3)?,
                    name: row.get(4)?,
                    artist: row.get(5)?,
                    artist_id: row.get(6)?,
                    song_count: row.get(7)?,
                    duration_sec: row.get(8)?,
                    year: row.get(9)?,
                    genre: row.get(10)?,
                    cover_art_id: row.get(11)?,
                    starred_at: row.get(12)?,
                    synced_at: row.get(13)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())
}

fn album_identity_priorities(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    candidates: &[Vec<AlbumCandidate>],
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
        "{scope_cte} SELECT projection.identity_key, MIN(scope.pr) \
         FROM scope \
         INNER JOIN album_browse_projection projection \
           ON projection.server_id = scope.server_id \
          AND projection.library_id = scope.library_id \
         WHERE projection.identity_key IN ({placeholders}) \
         GROUP BY projection.identity_key",
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

pub(super) fn browse_albums(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    let sort = album_sort(&request.sort)?;
    let cursor = parse_cursor(request.cursor.as_deref(), &request.scopes, sort)?;
    if cursor.is_none() {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &request.scopes)?;
    }
    let limit = request.limit.clamp(1, 200) as usize;
    let candidate_limit = CANDIDATE_PAGE_SIZE.max(limit.saturating_add(1));
    let mut candidates = Vec::with_capacity(request.scopes.len());
    let mut stream_exhausted = Vec::with_capacity(request.scopes.len());
    for (priority, scope) in request.scopes.iter().enumerate() {
        let stream = query_scope_candidates(
            store,
            scope,
            priority,
            sort,
            cursor
                .as_ref()
                .and_then(|cursor| cursor.positions.get(priority))
                .and_then(Option::as_ref),
            candidate_limit,
        )?;
        stream_exhausted.push(stream.len() < candidate_limit);
        candidates.push(stream);
    }
    let mut identity_priorities = album_identity_priorities(store, &request.scopes, &candidates)?;

    let mut albums = Vec::with_capacity(limit.saturating_add(1));
    let mut offsets = vec![0usize; candidates.len()];
    let mut positions = cursor
        .map(|cursor| cursor.positions)
        .unwrap_or_else(|| vec![None; request.scopes.len()]);
    while albums.len() < limit {
        for scope_index in 0..candidates.len() {
            if offsets[scope_index] < candidates[scope_index].len() || stream_exhausted[scope_index]
            {
                continue;
            }
            let stream = query_scope_candidates(
                store,
                &request.scopes[scope_index],
                scope_index,
                sort,
                positions[scope_index].as_ref(),
                candidate_limit,
            )?;
            stream_exhausted[scope_index] = stream.len() < candidate_limit;
            candidates[scope_index] = stream;
            offsets[scope_index] = 0;
            identity_priorities = album_identity_priorities(store, &request.scopes, &candidates)?;
        }
        let next_scope = candidates
            .iter()
            .enumerate()
            .filter(|(index, stream)| offsets[*index] < stream.len())
            .min_by(|(left_index, left_stream), (right_index, right_stream)| {
                candidate_cmp(
                    sort,
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
        positions[scope_index] = Some(cursor_position(candidate));
        if let Some(identity_key) = candidate.identity_key.as_deref() {
            if identity_priorities
                .get(identity_key)
                .is_some_and(|priority| *priority < candidate.priority)
            {
                continue;
            }
        }
        albums.push(candidate_to_dto(candidate.clone()));
    }
    // The projection stores the display credit and a representative track's performer id
    // side by side, so a compilation row reads "Various Artists" with a guest's id. Which
    // entity that credit links to belongs to the whole physical album, exactly as in the
    // merge paths — this is the page every "All Albums" grid renders.
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    let has_more = candidates
        .iter()
        .enumerate()
        .any(|(index, stream)| offsets[index] < stream.len() || !stream_exhausted[index]);
    let next_cursor = has_more.then(|| {
        serde_json::to_string(&AlbumCursor {
            scope_key: scope_key(&request.scopes),
            sort,
            positions,
        })
        .expect("scope browse cursor serializes")
    });
    Ok(LibraryScopeBrowseResponse {
        albums,
        artists: Vec::new(),
        tracks: Vec::new(),
        next_cursor,
        has_more,
        source: "local".into(),
    })
}
