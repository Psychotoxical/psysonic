use super::resolve_analysis_scope;

#[test]
fn explicit_canonical_key_beats_the_selected_transport_address() {
    // Primary vs alternate address must share one analysis scope: the
    // explicit canonical key wins over the URL-derived transport host.
    assert_eq!(
        resolve_analysis_scope(
            Some("canonical.example"),
            Some("canonical.example"),
            Some("lan.local:4533")
        ),
        "canonical.example"
    );
    assert_eq!(
        resolve_analysis_scope(Some("canonical.example"), None, Some("public.example/nav")),
        "canonical.example"
    );
}

#[test]
fn pinned_scope_then_url_are_fallbacks_only() {
    assert_eq!(
        resolve_analysis_scope(None, Some("pinned.example"), Some("lan.local")),
        "pinned.example"
    );
    assert_eq!(
        resolve_analysis_scope(None, None, Some("lan.local")),
        "lan.local"
    );
    assert_eq!(resolve_analysis_scope(Some("  "), None, None), "");
}
