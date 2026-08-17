use super::artwork::*;
use std::collections::HashMap;
use std::sync::Mutex;

// ── normalize ─────────────────────────────────────────────────────────────

#[test]
fn normalize_lowercases_and_collapses_whitespace() {
    assert_eq!(normalize("  Pink   FLOYD  "), "pink floyd");
    assert_eq!(normalize("The\tBeatles\n"), "the beatles");
}

#[test]
fn normalize_returns_empty_for_pure_whitespace() {
    assert_eq!(normalize(""), "");
    assert_eq!(normalize("   "), "");
}

#[test]
fn normalize_preserves_unicode_letters() {
    assert_eq!(normalize("Sigur Rós"), "sigur rós");
    assert_eq!(normalize("Mötley Crüe"), "mötley crüe");
}

// ── words_overlap ─────────────────────────────────────────────────────────

#[test]
fn words_overlap_returns_false_for_empty_inputs() {
    assert!(!words_overlap("", "anything"));
    assert!(!words_overlap("anything", ""));
    assert!(!words_overlap("", ""));
}

#[test]
fn words_overlap_returns_true_for_full_match() {
    assert!(words_overlap("a b c", "a b c"));
}

#[test]
fn words_overlap_meets_50_percent_threshold() {
    // "a b" vs "a c" — 1 of 2 words overlap → 50% (just meets ceil-half).
    assert!(words_overlap("a b", "a c"));
}

#[test]
fn words_overlap_below_threshold_returns_false() {
    // 1 of 4 words overlap = 25%.
    assert!(!words_overlap("a b c d", "a x y z"));
}

#[test]
fn words_overlap_handles_asymmetric_lengths() {
    // "the beatles" (2 words) vs "the beatles greatest hits" (4 words):
    // 2 common, min_len = 2 → threshold = 1+0 = 1, so true.
    assert!(words_overlap("the beatles", "the beatles greatest hits"));
}

// ── cache_and_return ──────────────────────────────────────────────────────

#[test]
fn cache_and_return_inserts_entry_with_url() {
    let cache: Mutex<HashMap<String, ArtworkCacheEntry>> = Mutex::new(HashMap::new());
    cache_and_return(&cache, "key".to_string(), "https://example/600x600.jpg");
    let g = cache.lock().unwrap();
    let entry = g.get("key").expect("entry inserted");
    assert_eq!(entry.url, "https://example/600x600.jpg");
    // fetched_at is set to now() — sanity-check it's recent.
    assert!(entry.fetched_at.elapsed() < std::time::Duration::from_secs(1));
}
