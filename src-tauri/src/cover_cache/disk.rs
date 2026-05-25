use std::path::{Path, PathBuf};

pub const DERIVE_TIERS: [u32; 4] = [128, 256, 512, 800];

/// `server_index_key` — host (+ optional path), same bucket as library `server_id`.
pub fn cover_dir(root: &Path, server_index_key: &str, cover_art_id: &str) -> PathBuf {
    root.join(server_index_key).join(cover_art_id)
}

pub fn tier_path(dir: &Path, tier: u32) -> PathBuf {
    dir.join(format!("{tier}.webp"))
}

#[allow(dead_code)]
pub fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

pub fn tier_exists(dir: &Path, tier: u32) -> Option<PathBuf> {
    let p = tier_path(dir, tier);
    if p.is_file() { Some(p) } else { None }
}
