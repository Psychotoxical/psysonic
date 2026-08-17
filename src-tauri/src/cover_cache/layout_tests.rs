use super::disk::{cover_dir, tier_path};

#[test]
fn disk_layout_paths() {
    let root = std::path::Path::new("/tmp/cover-test");
    let dir = cover_dir(root, "srv", "album", "al-1");
    assert_eq!(dir, root.join("srv").join("album").join("al-1"));
    assert_eq!(tier_path(&dir, 512), dir.join("512.webp"));
}
