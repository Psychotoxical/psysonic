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
pub fn album_credits_artist(
    album_display_artist: Option<&str>,
    canonical_artist_name: &str,
) -> bool {
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
    "feat",
    "feat.",
    "ft",
    "ft.",
    "featuring",
    "with",
    "vs",
    "vs.",
    "versus",
    "meets",
    "presents",
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
    sql_display_artist_from(&format!("{alias}.artist"), &format!("{alias}.album_artist"))
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
#[path = "album_compilation_filter/tests.rs"]
mod tests;
