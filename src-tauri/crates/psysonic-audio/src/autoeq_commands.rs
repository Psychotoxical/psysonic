//! AutoEQ proxy commands: fetch entry list and FixedBandEQ profiles from
//! GitHub via Rust to bypass WebView CORS.

use tauri::State;

use super::engine::{audio_http_client, AudioEngine};

/// AutoEQ raw-content base URL — the GitHub directory that holds every
/// FixedBandEQ profile by `(source, form, name)` (and `rig`-prefixed forms
/// for crinacle's measurements).
pub(crate) const AUTOEQ_RAW_BASE: &str =
    "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";

/// Pure URL builder for [`autoeq_fetch_profile`]. The AutoEQ repo lays out
/// FixedBandEQ profiles either as
///
///   `{base}/{source}/{form}/{name}/{name} FixedBandEQ.txt`           (most sources)
///   `{base}/{source}/{rig} {form}/{name}/{name} FixedBandEQ.txt`     (crinacle — rig-prefixed dir)
///
/// When `rig` is supplied the function emits the rig-prefixed candidate first
/// (so callers try it before the form-only fallback). When `rig` is `None`
/// only the form-only path is returned.
pub(crate) fn autoeq_profile_url_candidates(
    base: &str,
    source: &str,
    form: &str,
    name: &str,
    rig: Option<&str>,
) -> Vec<String> {
    let filename = format!("{} FixedBandEQ.txt", name);
    if let Some(r) = rig {
        vec![
            format!("{}/{}/{} {}/{}/{}", base, source, r, form, name, filename),
            format!("{}/{}/{}/{}/{}", base, source, form, name, filename),
        ]
    } else {
        vec![format!("{}/{}/{}/{}/{}", base, source, form, name, filename)]
    }
}

/// Proxy: fetches https://autoeq.app/entries via Rust to bypass WebView CORS restrictions.
#[tauri::command]
pub async fn autoeq_entries(state: State<'_, AudioEngine>) -> Result<String, String> {
    audio_http_client(&state)
        .get("https://autoeq.app/entries")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())
}

/// Fetches the AutoEQ FixedBandEQ profile for a specific headphone from GitHub raw content.
#[tauri::command]
pub async fn autoeq_fetch_profile(
    name: String,
    source: String,
    rig: Option<String>,
    form: String,
    state: State<'_, AudioEngine>,
) -> Result<String, String> {
    let candidates =
        autoeq_profile_url_candidates(AUTOEQ_RAW_BASE, &source, &form, &name, rig.as_deref());

    for url in &candidates {
        let resp = audio_http_client(&state).get(url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return resp.text().await.map_err(|e| e.to_string());
        }
    }

    Err(format!("FixedBandEQ profile not found for '{}'", name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_candidates_returns_form_only_path_when_no_rig_supplied() {
        let urls = autoeq_profile_url_candidates(
            "https://example/results",
            "oratory1990",
            "over-ear",
            "Sennheiser HD 600",
            None,
        );
        assert_eq!(
            urls,
            vec!["https://example/results/oratory1990/over-ear/Sennheiser HD 600/Sennheiser HD 600 FixedBandEQ.txt".to_string()]
        );
    }

    #[test]
    fn url_candidates_emits_rig_prefixed_candidate_first_when_rig_supplied() {
        // crinacle's measurements use a rig-prefixed directory like
        // `crinacle/IEC711 in-ear` instead of plain `crinacle/in-ear`.
        let urls = autoeq_profile_url_candidates(
            "https://example/results",
            "crinacle",
            "in-ear",
            "Moondrop Variations",
            Some("IEC711"),
        );
        assert_eq!(urls.len(), 2);
        assert_eq!(
            urls[0],
            "https://example/results/crinacle/IEC711 in-ear/Moondrop Variations/Moondrop Variations FixedBandEQ.txt",
            "rig-prefixed path tried first"
        );
        assert_eq!(
            urls[1],
            "https://example/results/crinacle/in-ear/Moondrop Variations/Moondrop Variations FixedBandEQ.txt",
            "form-only fallback emitted second"
        );
    }

    #[test]
    fn url_candidates_preserves_spaces_in_headphone_names() {
        let urls = autoeq_profile_url_candidates(
            "base",
            "src",
            "form",
            "Audio-Technica ATH-M50x",
            None,
        );
        // Spaces inside the name aren't URL-encoded — reqwest does that on send.
        assert!(urls[0].contains("Audio-Technica ATH-M50x"));
        assert!(urls[0].ends_with("Audio-Technica ATH-M50x FixedBandEQ.txt"));
    }

    #[test]
    fn url_candidates_uses_real_autoeq_base_in_production() {
        // The const is the production raw-content URL — guard against typos.
        assert!(AUTOEQ_RAW_BASE.starts_with("https://raw.githubusercontent.com/"));
        assert!(AUTOEQ_RAW_BASE.contains("/jaakkopasanen/AutoEq"));
        assert!(AUTOEQ_RAW_BASE.ends_with("/results"));
    }
}
