use std::path::{Path, PathBuf};

pub use psysonic_core::cover_cache_layout;

pub const DERIVE_TIERS: [u32; 4] = [128, 256, 512, 800];

/// Delegates to [`cover_cache_layout::cover_dir`] — disk path format lives in `psysonic-core`.
pub fn cover_dir(root: &Path, server_index_key: &str, cache_kind: &str, cache_entity_id: &str) -> PathBuf {
    cover_cache_layout::cover_dir(root, server_index_key, cache_kind, cache_entity_id)
}

pub fn tier_path(dir: &Path, tier: u32) -> PathBuf {
    dir.join(format!("{tier}.webp"))
}

/// External-provider tier file in the SAME entity dir, differentiated by a
/// filename suffix only (image-scraper §14/§16): `{tier}-{provider}.webp`
/// (e.g. `2000-fanart.webp`). The `coverStorageKey`/`cacheKind` is unchanged.
pub fn provider_tier_path(dir: &Path, tier: u32, provider: &str) -> PathBuf {
    dir.join(format!("{tier}-{provider}.webp"))
}

pub fn provider_tier_exists(dir: &Path, tier: u32, provider: &str) -> Option<PathBuf> {
    let p = provider_tier_path(dir, tier, provider);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

#[allow(dead_code)]
pub fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

pub fn tier_exists(dir: &Path, tier: u32) -> Option<PathBuf> {
    let p = tier_path(dir, tier);
    if p.is_file() { Some(p) } else { None }
}

/// Write missing WebP tiers up to `max_tier` (used by library bulk backfill).
pub fn write_derived_webp_tiers(
    dir: &Path,
    img: &image::DynamicImage,
    max_tier: u32,
) -> Result<(), String> {
    use super::encode::write_webp_tier;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for &tier in DERIVE_TIERS.iter() {
        if tier > max_tier {
            continue;
        }
        if tier_exists(dir, tier).is_some() {
            continue;
        }
        write_webp_tier(img, tier, &tier_path(dir, tier))?;
    }
    Ok(())
}
