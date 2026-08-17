use super::disk::tier_exists;
use super::dto::CoverCacheEnsureArgs;
use super::external_ensure;
use std::path::{Path, PathBuf};

pub(super) fn peek_fallback_tiers(want: u32) -> &'static [u32] {
    match want {
        512 => &[800, 256, 128],
        256 => &[800, 512, 128],
        128 => &[256, 512, 800],
        64 => &[128, 256, 512, 800],
        w if w > 512 && w < 800 => &[800, 512, 256, 128],
        w if w > 800 => &[512, 256, 128],
        _ => &[800, 512, 256, 128],
    }
}

/// Disk-only: exact tier, then grid-friendly upscales (512 → 800 before 128).
pub(super) fn peek_tier_path(dir: &Path, want: u32) -> Option<PathBuf> {
    if let Some(p) = tier_exists(dir, want) {
        return Some(p);
    }
    for &tier in peek_fallback_tiers(want) {
        if let Some(p) = tier_exists(dir, tier) {
            return Some(p);
        }
    }
    None
}

/// Disk peek for a plain (non-surface) cover request — shared by the ensure path
/// AND `cover_cache_peek_batch`. Full-res (≥2000) is **exact-only**: a smaller
/// peek-ladder fallback would both serve a downscaled image and short-circuit the
/// download, and (via the frontend grid seeder) poison the full-res in-memory key
/// for Hero / fullscreen / artist-hero surfaces, which peek 2000 before ensure.
/// Smaller display tiers keep the normal ladder peek.
pub(super) fn peek_plain_cover_tier(dir: &Path, tier: u32) -> Option<PathBuf> {
    if tier >= 2000 {
        return tier_exists(dir, tier);
    }
    peek_tier_path(dir, tier)
}

/// Peek used by the ensure path. External surfaces keep their own ladder; plain
/// covers go through [`peek_plain_cover_tier`] (full-res exact).
pub(super) fn ensure_peek(dir: &Path, tier: u32, args: &CoverCacheEnsureArgs) -> Option<PathBuf> {
    if args.surface_kind.is_some() {
        return external_ensure::peek_cover_path(dir, tier, args);
    }
    peek_plain_cover_tier(dir, tier)
}

#[cfg(test)]
mod tests {
    use super::{ensure_peek, peek_plain_cover_tier};
    use crate::cover_cache::disk::tier_path;
    use crate::cover_cache::dto::CoverCacheEnsureArgs;
    use crate::cover_cache::test_support::fresh_tmpdir;
    use std::fs;

    fn test_ensure_args(tier: u32, surface_kind: Option<&str>) -> CoverCacheEnsureArgs {
        CoverCacheEnsureArgs {
            server_index_key: "srv".into(),
            cache_kind: "album".into(),
            cache_entity_id: "al-1".into(),
            cover_art_id: "al-1".into(),
            tier,
            rest_base_url: "http://x".into(),
            username: "u".into(),
            password: "p".into(),
            library_bulk: false,
            library_server_id: None,
            external_artwork_enabled: false,
            surface_kind: surface_kind.map(String::from),
            artist_name: None,
            album_title: None,
            external_artwork_byok: None,
        }
    }

    #[test]
    fn ensure_peek_fullres_requires_exact_tier() {
        let root = fresh_tmpdir("ensure-peek-fullres");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 512), b"x").unwrap();
        let args = test_ensure_args(2000, None);
        assert!(ensure_peek(&dir, 2000, &args).is_none());
        fs::write(tier_path(&dir, 2000), b"y").unwrap();
        assert_eq!(ensure_peek(&dir, 2000, &args), Some(tier_path(&dir, 2000)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn peek_plain_cover_fullres_is_exact_but_display_tiers_ladder() {
        let root = fresh_tmpdir("peek-plain-fullres");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 512), b"x").unwrap();
        assert!(peek_plain_cover_tier(&dir, 2000).is_none());
        assert_eq!(peek_plain_cover_tier(&dir, 256), Some(tier_path(&dir, 512)));
        fs::write(tier_path(&dir, 2000), b"y").unwrap();
        assert_eq!(
            peek_plain_cover_tier(&dir, 2000),
            Some(tier_path(&dir, 2000))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_peek_display_tier_keeps_ladder_fallback() {
        let root = fresh_tmpdir("ensure-peek-ladder");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"x").unwrap();
        assert_eq!(
            ensure_peek(&dir, 256, &test_ensure_args(256, None)),
            Some(tier_path(&dir, 800)),
        );
        let _ = fs::remove_dir_all(&root);
    }
}
