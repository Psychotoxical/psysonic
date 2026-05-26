use image::imageops::FilterType;
use image::DynamicImage;
use std::path::Path;

pub fn resize_tier(img: &DynamicImage, tier: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let max_dim = w.max(h);
    if max_dim <= tier {
        return img.clone();
    }
    let scale = tier as f32 / max_dim as f32;
    let nw = (w as f32 * scale).round().max(1.0) as u32;
    let nh = (h as f32 * scale).round().max(1.0) as u32;
    img.resize(nw, nh, FilterType::Triangle)
}

/// Lossy WebP quality (0–100). Larger tiers use lower Q — UI rarely shows 800px raw;
/// dense grids cap at 512px (see `COVER_ART_DENSE_MAX_TIER`).
pub fn webp_quality_for_tier(tier: u32) -> f32 {
    match tier {
        2000 => 82.0,
        800 => 70.0,
        512 => 73.0,
        256 => 76.0,
        128 => 78.0,
        _ => 74.0,
    }
}

pub fn encode_webp(img: &DynamicImage, tier: u32) -> Result<Vec<u8>, String> {
    let rgba = img.to_rgba8();
    let enc = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    Ok(enc.encode(webp_quality_for_tier(tier)).to_vec())
}

pub fn write_webp_tier(img: &DynamicImage, tier: u32, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let resized = resize_tier(img, tier);
    let bytes = encode_webp(&resized, tier)?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;

    #[test]
    fn resize_tier_scales_down_large_canvas() {
        let img = DynamicImage::ImageRgba8(RgbaImage::new(800, 600));
        let out = resize_tier(&img, 128);
        assert!(out.width() <= 128);
        assert!(out.height() <= 128);
    }

    #[test]
    fn webp_quality_decreases_with_tier_size() {
        assert!(webp_quality_for_tier(800) < webp_quality_for_tier(512));
        assert!(webp_quality_for_tier(512) < webp_quality_for_tier(128));
        assert!(webp_quality_for_tier(800) < webp_quality_for_tier(2000));
    }

    #[test]
    fn webp_encode_800_smaller_than_old_lossless_upper_bound() {
        let img = DynamicImage::ImageRgba8(RgbaImage::new(800, 800));
        let bytes = encode_webp(&img, 800).expect("webp");
        assert!(
            bytes.len() < 250_000,
            "expected lossy 800 webp well under legacy JPEG cap, got {} bytes",
            bytes.len()
        );
    }
}
