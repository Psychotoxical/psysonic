//! OpenSubsonic compilation flag in entity `raw_json` (Navidrome: `compilation`,
//! `isCompilation`, or `releaseTypes` containing `Compilation`), plus the same
//! "Various Artists" heuristics the web UI uses when structured flags are absent.

/// Wrap a JSON1 expression so an invalid `raw_json` row yields `fallback` instead of
/// aborting the statement.
///
/// `raw_json` columns are unconstrained TEXT and the library tolerates invalid JSON
/// (`from_row` maps it to `Value::Null`), but JSON1 (`json_extract`, `json_each`,
/// `json_type`, `json_array_length`) raises `malformed JSON` on invalid text. Unguarded,
/// one bad row kills the whole query rather than simply not matching — and inside a
/// correlated sub-select it takes the caller's entire result set with it. SQLite gives
/// no short-circuit guarantee for `AND`, so the guard has to be a `CASE`, not a
/// conjunction. `json_valid(NULL)` is NULL, so a missing column takes the fallback
/// branch instead of throwing.
///
/// Single definition for every guarded JSON expression in this crate — pass `"0"` for
/// predicates (a non-matching row) and `"NULL"` for value lookups (no value).
pub(crate) fn json_guarded(json_col: &str, expr: &str, fallback: &str) -> String {
    format!("(CASE WHEN json_valid({json_col}) THEN ({expr}) ELSE {fallback} END)")
}

/// SQL predicate on any row with a `raw_json` column (album or track).
pub fn compilation_raw_json_sql(table_alias: &str) -> String {
    let a = table_alias;
    // A release-type array (OpenSubsonic top-level `releaseTypes` and the
    // Navidrome-native `tags.releasetype`) contains "Compilation". Both forms are
    // read, mirroring `usable_release_types_expr`: a track tagged only
    // `{"tags":{"releasetype":["Compilation"]}}` with no flat album-artist would
    // otherwise read as non-compilation and land in the main discography. The
    // `json_type = 'array'` guard keeps a scalar value from matching.
    let release_type_is_compilation = |path: &str| {
        format!(
            "EXISTS ( \
               SELECT 1 FROM json_each({a}.raw_json, '{p}') AS rt \
               WHERE json_type({a}.raw_json, '{p}') = 'array' \
                 AND lower(rt.value) = 'compilation' \
             )",
            a = a,
            p = path,
        )
    };
    // `NULL IN (...)` is unknown in SQL — wrap each probe in EXISTS so non-comp rows stay false.
    json_guarded(
        &format!("{a}.raw_json"),
        &format!(
            "EXISTS ( \
               SELECT 1 WHERE json_extract({a}.raw_json, '$.compilation') IN (1, '1', 'true', 'TRUE') \
             ) OR EXISTS ( \
               SELECT 1 WHERE json_extract({a}.raw_json, '$.isCompilation') IN (1, '1', 'true', 'TRUE') \
             ) OR {top} OR {nested}",
            top = release_type_is_compilation("$.releaseTypes"),
            nested = release_type_is_compilation("$.tags.releasetype"),
        ),
        "0",
    )
}

pub(crate) fn various_artists_like_sql(column: &str) -> String {
    format!(
        "lower(trim(coalesce({column}, ''))) LIKE '%various artists%'",
        column = column
    )
}

/// Credits that name a collection rather than a performer.
///
/// Deliberately separate from [`various_artists_like_sql`], which is a browse
/// *filter*: there, missing a spelling only under-reports a compilation. This
/// one guards album **identity** — a credit that survives it becomes half of an
/// album key, so two unrelated records tagged `Various` / `Soundtrack` and
/// sharing a title would collapse into one album. The cost of being too strict
/// is a physical key, which is what such albums had before; the cost of being
/// too loose is a wrong merge the user cannot undo.
pub(crate) fn collection_credit_sql(column: &str) -> String {
    let normalized = format!("lower(trim(coalesce({column}, '')))");
    let exact = [
        "various",
        "various artist",
        "various artists",
        "va",
        "v.a",
        "v.a.",
        "diverse artister",
        "diversos artistas",
        "artistes variés",
        "vários artistas",
        "varios artistas",
        "verschiedene künstler",
        "verscheidene artiesten",
        "sampler",
        "compilation",
        "compilations",
        "soundtrack",
        "original soundtrack",
        "original motion picture soundtrack",
        "original score",
        "ost",
        "unknown artist",
        "unknown",
    ]
    .map(|label| format!("'{label}'"))
    .join(", ");
    format!("({normalized} IN ({exact}) OR {normalized} LIKE '%various artists%')")
}

/// Full compilation predicate for browse filters — JSON flags plus VA artist labels.
pub fn compilation_predicate_sql(
    table_alias: &str,
    artist_column: Option<&str>,
    album_artist_column: Option<&str>,
) -> String {
    let mut parts = vec![compilation_raw_json_sql(table_alias)];
    parts.push(json_guarded(
        &format!("{table_alias}.raw_json"),
        &format!(
            "lower(trim(coalesce(json_extract({table_alias}.raw_json, '$.displayArtist'), ''))) \
             LIKE '%various artists%'"
        ),
        "0",
    ));
    if let Some(col) = artist_column {
        parts.push(various_artists_like_sql(col));
    }
    if let Some(col) = album_artist_column {
        parts.push(various_artists_like_sql(col));
    }
    format!("({})", parts.join(" OR "))
}

/// True when a credit is the "Various Artists" compilation label. Word-boundary
/// matched to stay identical to the frontend `isVariousArtistsLabel`
/// (`/\bvarious artists\b/i`): both gate the same album-artist unlink on the same
/// album, so a substring match here against a word-boundary match there would let one
/// side unlink while the other relinks to a guest performer. (The album-inclusion
/// `LIKE '%various artists%'` in `various_artists_like_sql` stays a substring match —
/// that is a different decision.)
pub fn various_artists_label(s: &str) -> bool {
    const NEEDLE: &str = "various artists";
    let hay = s.trim().to_ascii_lowercase();
    let bytes = hay.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut from = 0;
    while let Some(rel) = hay[from..].find(NEEDLE) {
        let start = from + rel;
        let end = start + NEEDLE.len();
        let before_boundary = start == 0 || !is_word(bytes[start - 1]);
        let after_boundary = end >= bytes.len() || !is_word(bytes[end]);
        if before_boundary && after_boundary {
            return true;
        }
        from = start + 1;
    }
    false
}

/// Whether a track-derived album's display album-artist credits the given artist:
/// it either *is* the artist, or is a collaboration led by them
/// ("Artist & Guest", "Artist feat. Guest"). Other artists' albums and "Various
/// Artists" credits do not, so they fall out of the main discography.
///
/// This is only the album-artist half of the artist-page split; a compilation
/// flag from the track `raw_json` (see [`compilation_predicate_sql`], evaluated in
/// SQL where the raw JSON is available) still routes an album to *appears-on* even
/// when it credits the artist. The comparison is on the already-normalized display
/// album-artist ([`pick_album_group_artist`]), so it is ingest-path agnostic, and
/// uses Unicode-aware lowercasing because catalogs carry non-ASCII artist names.
///
/// Beyond an exact (normalized, article-insensitive) match, the name must be followed
/// by a whitespace-separated collaboration join — see [`CREDIT_JOIN_SYMBOLS`] and
/// [`CREDIT_JOIN_WORDS`]. A band whose own name merely extends another artist's name
/// ("Mumford & Sons" vs "Mumford") still matches its own albums by equality.
pub fn album_credits_artist(album_display_artist: Option<&str>, canonical_artist_name: &str) -> bool {
    let canonical = canonical_artist_name.trim().to_lowercase();
    if canonical.is_empty() {
        return false;
    }
    let Some(display) = album_display_artist else {
        return false;
    };
    let display = display.trim().to_lowercase();
    // Identity comparison goes through `norm_part` — the same normalization that
    // built the `artist_key` this album set was gathered by (NFD fold, combining
    // marks dropped, alphanumerics only) — after dropping a leading article. A raw
    // compare would exile an artist's own releases to "appears on" whenever the two
    // sides spell the name differently: two scoped servers disagreeing on diacritics
    // ("Röyksopp" vs "Royksopp", "AC/DC" vs "AC-DC"), or the extremely common case of
    // an entity named "The Beatles" whose albums are tagged `albumartist = Beatles`
    // (servers derive that from sort names). Both cluster into one artist, so failing
    // the credit check would empty the whole discography into "appears on".
    let article_free = |s: &str| {
        crate::identity::norm_part(&crate::artist_sort::strip_leading_articles(
            s,
            crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
        ))
    };
    match (article_free(&display), article_free(&canonical)) {
        (Some(d), Some(c)) if d == c => return true,
        _ => {}
    }
    // Collaboration credit ("<artist> & <guest>", "<artist> feat. <guest>"): the
    // album is still headed by the artist. Matched on the raw strings because the
    // rule needs the separator that `norm_part` strips.
    //
    // The remainder must look like a *join*, not merely start with a non-alphanumeric
    // character: a plain space would credit "Air Supply" to "Air" and "Death Cab for
    // Cutie" to "Death", filing another band's album under this artist's own
    // discography. The trailing-boundary requirement also keeps "Metallica" from
    // crediting "Metallican".
    let Some(rest) = display.strip_prefix(&canonical) else {
        return false;
    };
    credit_rest_is_collaboration_join(rest)
}

/// Symbols and words that join a lead credit to a guest credit.
///
/// Bare conjunction *words* (`and`, `x`) are deliberately absent: unlike the symbols
/// they are just as likely to be the middle of a different band's name that happens to
/// start with this artist's name ("Belle" vs "Belle and Sebastian"). The symbols stay
/// because real releases depend on them — "Metallica & San Francisco Symphony" is
/// Metallica's own album and must not leave their discography.
const CREDIT_JOIN_SYMBOLS: &[char] = &['&', '+', '/', ';', '×'];
const CREDIT_JOIN_WORDS: &[&str] = &[
    "feat", "feat.", "ft", "ft.", "featuring", "with", "vs", "vs.", "versus", "meets", "presents",
];

/// True when the text following a leading artist-name match reads as a collaboration
/// join rather than the continuation of a longer band name.
fn credit_rest_is_collaboration_join(rest: &str) -> bool {
    // The join marker must be whitespace-separated from the artist name — for words so
    // that "Ex" cannot match inside "Extreme", and for symbols so that a comma running
    // straight on from the name cannot: "Earth, Wind & Fire" is not an Earth release,
    // and "Air Supply" is not an Air one.
    if !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let trimmed = rest.trim_start();
    if trimmed.is_empty() {
        // "<artist> " with nothing after it — the names are equal bar whitespace.
        return true;
    }
    if trimmed.starts_with(CREDIT_JOIN_SYMBOLS) {
        return true;
    }
    // "<artist> (feat. <guest>)" — a bracketed credit is as common as the bare form on
    // OpenSubsonic servers. The bracket alone proves nothing, so it only opens the door
    // for the same join words; that keeps "Artist (Live)" or "Artist (Remastered)" out.
    let word = trimmed
        .trim_start_matches(['(', '[', '{'])
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches(':');
    CREDIT_JOIN_WORDS.contains(&word)
}

/// SQL mirror of [`pick_album_group_artist`] over arbitrary column *expressions*
/// rather than a table alias — the album browse groups by album and therefore has
/// to feed aggregates (`MAX(t.artist)`, `MAX(t.album_artist)`), while the
/// multi-library dedup path feeds projected columns (`artist`, `album_artist`).
/// Single source of the rule; keep in sync with [`pick_album_group_artist`].
pub fn sql_display_artist_from(track_artist: &str, album_artist: &str) -> String {
    format!(
        "CASE WHEN trim(coalesce({aa}, '')) != '' \
         THEN trim({aa}) \
         ELSE NULLIF(trim(coalesce({ta}, '')), '') END",
        aa = album_artist,
        ta = track_artist,
    )
}

/// SQL mirror of [`pick_album_group_artist`] for track-grouped browse subqueries
/// (`la`). Used where `ORDER BY` / `COALESCE(a.artist, …)` must stay in SQL;
/// keep both implementations in sync.
pub fn sql_track_group_display_artist(alias: &str) -> String {
    sql_display_artist_from(
        &format!("{alias}.artist"),
        &format!("{alias}.album_artist"),
    )
}

/// Row-mapper form of the album-artist display rule — mirror of
/// [`sql_track_group_display_artist`]. Prefer a non-empty album-artist tag;
/// fall back to track artist only when album artist is absent (solo albums without TALB).
pub fn pick_album_group_artist(
    track_artist: Option<String>,
    album_artist: Option<String>,
) -> Option<String> {
    let aa = album_artist.as_deref().unwrap_or("").trim();
    if !aa.is_empty() {
        return Some(aa.to_string());
    }
    track_artist.filter(|s| !s.trim().is_empty())
}

/// Id-side mirror of [`pick_album_group_artist`]: pick the *artist id* the album
/// header should link to. When the album carries a named album-artist — so the
/// displayed credit comes from `album_artist` — the link must point at that
/// album-artist entity (`raw_json.albumArtistId`), not a representative track's
/// `artist_id`. On a "Various Artists" compilation the album-artist id differs
/// from every track performer's id; without this the hero reads "Various Artists"
/// but opens one of the guest performers. Falls back to the track artist id when
/// the album has no named album-artist, or when the server supplied no
/// album-artist id (keeps the credit and link consistent rather than mislabelling).
/// Keep the branch condition in sync with [`pick_album_group_artist`].
pub fn pick_album_group_artist_id(
    track_artist_id: Option<String>,
    album_artist: Option<&str>,
    album_artist_id: Option<String>,
) -> Option<String> {
    let named = album_artist.map(str::trim).filter(|s| !s.is_empty());
    if named.is_some() {
        if let Some(id) = album_artist_id.filter(|s| !s.trim().is_empty()) {
            return Some(id);
        }
    }
    // A "Various Artists" credit with no album-artist id must stay unlinked: the
    // track performer is definitely *not* the album artist here, so linking to it
    // would open a single guest under a Various Artists label. Everywhere else the
    // performer id keeps credit and link on the same entity.
    if named.is_some_and(various_artists_label) {
        return None;
    }
    track_artist_id.filter(|s| !s.trim().is_empty())
}

/// An album card's display credit and the entity its link opens, resolved together
/// from a track's artist, the album-artist label, and the album-artist id. Both follow
/// the same album-artist choice, so a compilation reads "Various Artists" *and* links to
/// that entity instead of a track performer. One rule shared by every album-DTO mapper
/// (`album_row_to_dto`, the mainstage feed, album detail).
///
/// Caller responsibility: the three inputs should come from one representative track so
/// the credit and link agree. The dedup grid/mainstage queries ensure this via a bare
/// `album_artist_id` + single `MIN(_pick)`; the all-`MAX` grouped fast paths aggregate
/// each column independently, so they agree only on well-tagged albums (every track of
/// the album carrying the same `album_artist` / `albumArtistId`, i.e. the normal case).
pub fn resolve_album_credit(
    track_artist: Option<String>,
    track_artist_id: Option<String>,
    album_artist: Option<String>,
    album_artist_id: Option<String>,
) -> (Option<String>, Option<String>) {
    let id = pick_album_group_artist_id(track_artist_id, album_artist.as_deref(), album_artist_id);
    (pick_album_group_artist(track_artist, album_artist), id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn various_artists_label_is_word_boundary_matched() {
        assert!(various_artists_label("Various Artists"));
        assert!(various_artists_label("  various artists  "));
        assert!(various_artists_label("VA / Various Artists"));
        assert!(various_artists_label("Various Artists!"));
        // Word-boundary, mirroring the frontend regex: an alnum-adjacent occurrence
        // is not the label. These are exactly the strings a substring match would
        // have disagreed with the frontend on.
        assert!(!various_artists_label("various artistsX"));
        assert!(!various_artists_label("Xvarious artists"));
        assert!(!various_artists_label("Metallica"));
        assert!(!various_artists_label(""));
    }

    #[test]
    fn sql_mentions_json_paths() {
        let sql = compilation_raw_json_sql("t");
        assert!(sql.contains("$.compilation"));
        assert!(sql.contains("$.releaseTypes"));
        assert!(sql.contains("$.tags.releasetype"));
    }

    #[test]
    fn compilation_raw_json_sql_recognizes_every_representation() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (raw_json TEXT)", []).unwrap();
        let sql = format!("SELECT {} FROM t", compilation_raw_json_sql("t"));

        // (raw_json, expected-compilation)
        let cases: &[(&str, bool)] = &[
            (r#"{"compilation":1}"#, true),
            (r#"{"compilation":"true"}"#, true),
            (r#"{"isCompilation":true}"#, true),
            (r#"{"releaseTypes":["Album","Compilation"]}"#, true),
            // Navidrome-native nested tag — the representation the fix adds.
            (r#"{"tags":{"releasetype":["Compilation"]}}"#, true),
            (r#"{"tags":{"releasetype":["compilation"]}}"#, true),
            // Not a compilation.
            (r#"{"tags":{"releasetype":["Album"]}}"#, false),
            (r#"{"releaseTypes":["Album"]}"#, false),
            (r#"{"albumArtist":"Someone"}"#, false),
            // A scalar (not an array) must not match, and malformed JSON must not
            // abort — it takes the guarded fallback and simply doesn't match.
            (r#"{"tags":{"releasetype":"Compilation"}}"#, false),
            ("{not valid json", false),
        ];

        for (raw, expected) in cases {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t (raw_json) VALUES (?1)", [raw]).unwrap();
            let got: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
            assert_eq!(got == 1, *expected, "raw_json={raw}");
        }
    }

    #[test]
    fn predicate_includes_artist_columns() {
        let sql = compilation_predicate_sql("t", Some("t.artist"), Some("t.album_artist"));
        assert!(sql.contains("t.artist"));
        assert!(sql.contains("t.album_artist"));
        assert!(sql.contains("$.displayArtist"));
    }

    #[test]
    fn album_credits_artist_matches_self_and_led_collaborations() {
        // Exact and case/space-insensitive self credit.
        assert!(album_credits_artist(Some("Metallica"), "Metallica"));
        assert!(album_credits_artist(Some("  metallica "), "Metallica"));
        // Collaboration the artist leads keeps the album as their own.
        assert!(album_credits_artist(
            Some("Metallica & San Francisco Symphony"),
            "Metallica"
        ));
        assert!(album_credits_artist(Some("Bela B. feat. Smokestack"), "Bela B."));
        // Bracketed credit — the dominant OpenSubsonic `displayArtist` convention.
        assert!(album_credits_artist(
            Some("Some Artist (feat. A Guest)"),
            "Some Artist"
        ));
        // ...but a bracket alone is not a credit: a qualifier must not count.
        assert!(!album_credits_artist(Some("Some Artist (Live)"), "Some Artist"));
        // A band name that itself contains the separator matches by equality.
        assert!(album_credits_artist(Some("Mumford & Sons"), "Mumford & Sons"));
        // Non-ASCII names fold correctly.
        assert!(album_credits_artist(Some("Чиж & Co"), "Чиж"));
        // Diacritics and punctuation fold through the same normalization that built
        // the cluster key, so two servers spelling the name differently still match.
        assert!(album_credits_artist(Some("Royksopp"), "Röyksopp"));
        assert!(album_credits_artist(Some("AC-DC"), "AC/DC"));
        // A leading article on either side is not a different artist: servers commonly
        // tag `albumartist = Beatles` for the entity "The Beatles".
        assert!(album_credits_artist(Some("Beatles"), "The Beatles"));
        assert!(album_credits_artist(Some("The Beatles"), "Beatles"));
    }

    #[test]
    fn album_credits_artist_rejects_others_and_partial_names() {
        assert!(!album_credits_artist(Some("Various Artists"), "Metallica"));
        assert!(!album_credits_artist(Some("Another Artist"), "The Band"));
        // A separator is required after the name, so a longer name is not credited.
        assert!(!album_credits_artist(Some("Metallican"), "Metallica"));
        // A different band whose name merely *extends* this one is not credited: the
        // join marker has to be whitespace-separated, and a bare conjunction word is
        // not a join marker at all. Without this the whole catalogue of the longer
        // band would be filed into this artist's discography.
        assert!(!album_credits_artist(Some("Air Supply"), "Air"));
        assert!(!album_credits_artist(Some("Earth, Wind & Fire"), "Earth"));
        assert!(!album_credits_artist(
            Some("Death Cab for Cutie"),
            "Death"
        ));
        assert!(!album_credits_artist(Some("Belle and Sebastian"), "Belle"));
        // The artist must lead the credit, not merely appear in it.
        assert!(!album_credits_artist(
            Some("San Francisco Symphony & Metallica"),
            "Metallica"
        ));
        assert!(!album_credits_artist(None, "Metallica"));
        assert!(!album_credits_artist(Some("Metallica"), ""));
    }

    #[test]
    fn pick_album_group_artist_prefers_nonempty_album_artist() {
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Various Artists".into())),
            Some("Various Artists".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Groove Armada".into()), Some("Underworld".into())),
            Some("Underworld".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("Bob".into())),
            Some("Bob".to_string())
        );
    }

    #[test]
    fn pick_album_group_artist_falls_back_to_track_artist() {
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), None),
            Some("Alice".to_string())
        );
        assert_eq!(
            pick_album_group_artist(Some("Alice".into()), Some("".into())),
            Some("Alice".to_string())
        );
        assert_eq!(pick_album_group_artist(None, None), None);
    }

    #[test]
    fn pick_album_group_artist_id_mirrors_name_side() {
        // Named album-artist with an id → link to that album-artist entity, even
        // though the representative track performer differs (the VA / collaboration
        // case: display credit and link stay on the same entity).
        assert_eq!(
            pick_album_group_artist_id(
                Some("track-performer".into()),
                Some("Various Artists"),
                Some("va-id".into()),
            ),
            Some("va-id".to_string())
        );
        // Named "Various Artists" but the server gave no album-artist id → leave the
        // link empty. The track performer is provably not the album artist here, so
        // linking to it would open one guest under a Various Artists credit.
        assert_eq!(
            pick_album_group_artist_id(Some("track-performer".into()), Some("Various Artists"), None),
            None
        );
        // Any other named album-artist without an id keeps the track id, so credit
        // and link stay on the same entity rather than going blank.
        assert_eq!(
            pick_album_group_artist_id(Some("track-performer".into()), Some("Alice"), None),
            Some("track-performer".to_string())
        );
        // Blank album-artist must not count as named → fall back to the track id,
        // ignoring any stray album-artist id.
        assert_eq!(
            pick_album_group_artist_id(Some("solo".into()), Some("   "), Some("ignored".into())),
            Some("solo".to_string())
        );
        assert_eq!(
            pick_album_group_artist_id(Some("solo".into()), None, None),
            Some("solo".to_string())
        );
        // Nothing usable anywhere.
        assert_eq!(pick_album_group_artist_id(None, Some("Various Artists"), Some("  ".into())), None);
    }

    #[test]
    fn sql_track_group_display_artist_matches_pick_album_group_artist() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE la (artist TEXT, album_artist TEXT)",
            [],
        )
        .unwrap();
        let sql = format!("SELECT {} FROM la", sql_track_group_display_artist("la"));

        let cases: [(&str, &str); 7] = [
            ("Groove Armada", "Underworld"),
            ("Alice", ""),
            ("", "Various Artists"),
            ("Alice", "Bob"),
            ("  ", "Bob"),
            ("Alice", "   "),
            ("", ""),
        ];

        for (track, album) in cases {
            conn.execute("DELETE FROM la", []).unwrap();
            conn.execute(
                "INSERT INTO la (artist, album_artist) VALUES (?1, ?2)",
                rusqlite::params![track, album],
            )
            .unwrap();
            let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).ok();
            let rust_out = pick_album_group_artist(
                (!track.is_empty()).then(|| track.to_string()),
                (!album.is_empty()).then(|| album.to_string()),
            );
            assert_eq!(
                sql_out, rust_out,
                "track={track:?} album={album:?}"
            );
        }
    }

    /// Same parity, but for the **aggregate** form the grouped album browse sorts on.
    ///
    /// `map_album_from_tracks` builds a row's display artist as
    /// `pick_album_group_artist(MAX(artist), MAX(album_artist))`, so the sort key
    /// must be `sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)")` over
    /// the same aggregates — anything else sorts the album under a name the row does
    /// not show (#1217). The multi-row groups here are the point: a single row cannot
    /// tell an aggregate apart from a bare column.
    #[test]
    fn sql_display_artist_from_aggregates_matches_pick_album_group_artist() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (artist TEXT, album_artist TEXT)", [])
            .unwrap();
        let sql = format!(
            "SELECT {} FROM t",
            sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)"),
        );

        // Each case is one album's worth of tracks — album_artist deliberately sparse.
        let groups: [&[(&str, Option<&str>)]; 5] = [
            // Featured guest on one track only; the album artist is what shows.
            &[("Alpha", Some("Alpha")), ("Alpha feat. Zulu", None)],
            // Album artist on the *second* track — MAX still has to find it.
            &[("Alpha feat. Zulu", None), ("Alpha", Some("Alpha"))],
            // No album artist anywhere: falls back to the track credit.
            &[("Alpha", None), ("Alpha feat. Zulu", None)],
            // Blank strings must not count as an album artist.
            &[("Alice", Some("   ")), ("Alice feat. Bob", Some(""))],
            // Compilation: every track carries the same album artist.
            &[("Alice", Some("Various Artists")), ("Bob", Some("Various Artists"))],
        ];

        for rows in groups {
            conn.execute("DELETE FROM t", []).unwrap();
            for (artist, album_artist) in rows {
                conn.execute(
                    "INSERT INTO t (artist, album_artist) VALUES (?1, ?2)",
                    rusqlite::params![artist, album_artist],
                )
                .unwrap();
            }
            let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).unwrap();

            // The Rust side of the same decision, over the same aggregates.
            let max_artist = rows.iter().map(|(a, _)| *a).max().map(str::to_string);
            let max_album_artist = rows
                .iter()
                .filter_map(|(_, aa)| *aa)
                .max()
                .map(str::to_string);
            let rust_out = pick_album_group_artist(max_artist, max_album_artist);

            assert_eq!(sql_out, rust_out, "rows={rows:?}");
        }
    }
}
