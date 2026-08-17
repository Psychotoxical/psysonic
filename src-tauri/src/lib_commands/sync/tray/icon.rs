use tauri::image::Image;

/// Debug builds: mirror the default app icon horizontally so the tray differs from release.
pub(super) fn app_tray_icon(app: &tauri::AppHandle) -> Image<'static> {
    let icon = app.default_window_icon().expect("default window icon");
    #[cfg(debug_assertions)]
    {
        flip_image_horizontal(icon)
    }
    #[cfg(not(debug_assertions))]
    {
        icon.clone().to_owned()
    }
}

#[cfg(debug_assertions)]
fn flip_image_horizontal(icon: &Image<'_>) -> Image<'static> {
    let width = icon.width();
    let height = icon.height();
    let mut rgba = icon.rgba().to_vec();
    flip_rgba_horizontal(&mut rgba, width, height);
    Image::new_owned(rgba, width, height)
}

#[cfg(debug_assertions)]
fn flip_rgba_horizontal(rgba: &mut [u8], width: u32, height: u32) {
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return;
    }
    for y in 0..h {
        let row = y * w * 4;
        for x in 0..w / 2 {
            let l = row + x * 4;
            let r = row + (w - 1 - x) * 4;
            let left = [rgba[l], rgba[l + 1], rgba[l + 2], rgba[l + 3]];
            let right = [rgba[r], rgba[r + 1], rgba[r + 2], rgba[r + 3]];
            rgba[l..l + 4].copy_from_slice(&right);
            rgba[r..r + 4].copy_from_slice(&left);
        }
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::flip_rgba_horizontal;

    #[test]
    fn flip_rgba_horizontal_mirrors_pixels() {
        // 3x1: A B C -> C B A
        let mut rgba = vec![
            1, 0, 0, 255, // A
            2, 0, 0, 255, // B
            3, 0, 0, 255, // C
        ];
        flip_rgba_horizontal(&mut rgba, 3, 1);
        assert_eq!(rgba[0], 3);
        assert_eq!(rgba[4], 2);
        assert_eq!(rgba[8], 1);
    }
}
