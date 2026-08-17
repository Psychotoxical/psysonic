/// Shared HTTP client for the Music Network provider transports
/// (Audioscrobbler, ListenBrainz, and Maloja). The bounded timeout keeps a hung
/// provider from leaving scrobble, probe, or loved-sync promises unresolved.
pub(super) fn provider_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}
