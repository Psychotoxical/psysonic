//! Display-name → sort/bucket key (Navidrome `SanitizeFieldForSortingNoArticle` subset).

/// Navidrome default (`utils/str/sanitize_strings_test.go`).
pub const DEFAULT_IGNORED_ARTICLES: &str = "The El La Los Las Le Les Os As O A";

/// Strip leading articles from a display name (case-insensitive article match).
pub fn strip_leading_articles(name: &str, ignored_articles: &str) -> String {
    let trimmed = name.trim();
    for article in ignored_articles.split(' ').filter(|s| !s.is_empty()) {
        let prefix = format!("{} ", article);
        if trimmed.len() >= prefix.len()
            && trimmed[..prefix.len()].eq_ignore_ascii_case(&prefix)
        {
            return trimmed[prefix.len()..].trim_start().to_string();
        }
    }
    trimmed.to_string()
}

/// Lowercase sort key used for SQL `ORDER BY` and UI letter buckets.
pub fn sort_key_for_display_name(name: &str, ignored_articles: &str) -> String {
    strip_leading_articles(name, ignored_articles).to_lowercase()
}

pub fn ignored_articles_or_default(ignored_articles: Option<&str>) -> &str {
    match ignored_articles.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => DEFAULT_IGNORED_ARTICLES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_from_beatles() {
        let key = sort_key_for_display_name("The Beatles", DEFAULT_IGNORED_ARTICLES);
        assert_eq!(key, "beatles");
    }

    #[test]
    fn strips_the_from_kinks() {
        let key = sort_key_for_display_name("The Kinks", DEFAULT_IGNORED_ARTICLES);
        assert_eq!(key, "kinks");
    }

    #[test]
    fn leaves_non_article_names() {
        assert_eq!(
            sort_key_for_display_name("Adele", DEFAULT_IGNORED_ARTICLES),
            "adele"
        );
    }

    #[test]
    fn custom_ignored_articles() {
        assert_eq!(
            sort_key_for_display_name("The Beatles", "The"),
            "beatles"
        );
    }
}
