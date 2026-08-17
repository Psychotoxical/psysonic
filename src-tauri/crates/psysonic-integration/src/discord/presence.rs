/// Query-param keys that carry a replayable auth secret. Checked
/// case-insensitively; Subsonic's own keys (`u`/`t`/`s`) are lower-case but
/// the defensive variants guard against other backends / auth schemes.
const CREDENTIAL_PARAM_KEYS: &[&str] = &["u", "t", "s", "p", "apikey", "jwt", "token", "auth"];

/// Backstop gate: true when `url` is safe to publish to Discord as a
/// `large_image`. Discord's external image proxy re-exposes the source URL
/// to anyone viewing the presence, so this must reject anything credentialed
/// or LAN-scoped before it ever reaches `Assets::large_image` — regardless of
/// which frontend code path produced the URL (mirrors the sanitizer in
/// `src/cover/integrations/discord.ts`, but this is the layer a frontend
/// regression cannot bypass). The LAN/loopback check reuses
/// `psysonic_core::log_sanitize::is_lan_host`, the same host classification
/// already relied on for local-log redaction, rather than a second
/// hand-written copy.
pub(super) fn is_publishable_image_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    if psysonic_core::log_sanitize::is_lan_host(parsed.host_str().unwrap_or("")) {
        return false;
    }
    for (key, _) in parsed.query_pairs() {
        if CREDENTIAL_PARAM_KEYS.contains(&key.to_lowercase().as_str()) {
            return false;
        }
    }
    true
}

/// Apply a template string, replacing placeholders with actual values.
/// Supported placeholders: {title}, {artist}, {album}
pub(super) fn apply_template(
    template: &str,
    title: &str,
    artist: &str,
    album: Option<&str>,
) -> String {
    let album_text = album.unwrap_or("");
    template
        .replace("{title}", title)
        .replace("{artist}", artist)
        .replace("{album}", album_text)
}

/// Bundled output of [`compute_discord_text_fields`].
pub(super) struct DiscordTextFields {
    pub name: String,
    pub details: String,
    pub state: String,
    pub large_text: String,
}

/// Pure helper: resolve all four configurable Discord text fields, applying
/// the supplied templates (or falling back to documented defaults).
pub(super) fn compute_discord_text_fields(
    title: &str,
    artist: &str,
    album: Option<&str>,
    details_template: Option<&str>,
    state_template: Option<&str>,
    large_text_template: Option<&str>,
    name_template: Option<&str>,
) -> DiscordTextFields {
    let name = apply_template(name_template.unwrap_or("{title}"), title, artist, album);
    let details = apply_template(
        details_template.unwrap_or("{artist} - {title}"),
        title,
        artist,
        album,
    );
    let state = apply_template(state_template.unwrap_or("{album}"), title, artist, album);
    let large_text = apply_template(
        large_text_template.unwrap_or("{album}"),
        title,
        artist,
        album,
    );
    DiscordTextFields {
        name,
        details,
        state,
        large_text,
    }
}

/// Pure helper: compute the Unix-timestamp `start` field that Discord uses
/// to show "X minutes elapsed" when `elapsed_secs` is supplied.
pub(super) fn compute_discord_start_timestamp(elapsed_secs: f64, now_unix_secs: i64) -> i64 {
    now_unix_secs - elapsed_secs.floor() as i64
}
