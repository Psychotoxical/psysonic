use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;
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

pub fn encode_webp(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::WebP)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

pub fn write_webp_tier(img: &DynamicImage, tier: u32, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let resized = resize_tier(img, tier);
    let bytes = encode_webp(&resized)?;
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
}
