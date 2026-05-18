//! MP4/M4A layout helpers for HTTP streaming path selection.

/// True when the Subsonic / sniffed container hint is ISO-BMFF (m4a, mp4, …).
pub(crate) fn container_hint_is_mp4(hint: Option<&str>) -> bool {
    let Some(h) = hint else { return false };
    matches!(
        h.to_ascii_lowercase().as_str(),
        "m4a" | "m4af" | "mp4" | "m4b" | "mov" | "mp4a" | "isom"
    )
}

/// Walk top-level atoms in `prefix` and return true when `mdat` appears before `moov`
/// (classic non–fast-start layout — Symphonia must read the `moov` near EOF).
pub(crate) fn mp4_moov_follows_mdat(prefix: &[u8]) -> bool {
    let mut pos = 0usize;
    let mut saw_mdat = false;
    while pos + 8 <= prefix.len() {
        let atom_size = match read_mp4_atom_size(prefix, pos) {
            Some(s) => s,
            None => break,
        };
        if atom_size < 8 {
            break;
        }
        let atom_type = &prefix[pos + 4..pos + 8];
        if atom_type == b"mdat" {
            saw_mdat = true;
        }
        if atom_type == b"moov" {
            return saw_mdat;
        }
        let advance = atom_size.min((prefix.len() - pos) as u64) as usize;
        if advance < 8 {
            break;
        }
        pos += advance;
    }
    false
}

/// True when we should prefetch the file tail before linear fill (moov-at-end).
pub(crate) fn mp4_needs_tail_prefetch(prefix: &[u8], hint: Option<&str>) -> bool {
    if !container_hint_is_mp4(hint) {
        return false;
    }
    if prefix.is_empty() {
        return true;
    }
    if mp4_moov_follows_mdat(prefix) {
        return true;
    }
    // mdat seen but no moov in the scanned prefix — moov is likely at EOF.
    let mut pos = 0usize;
    let mut saw_mdat = false;
    let mut saw_moov = false;
    while pos + 8 <= prefix.len() {
        let atom_size = match read_mp4_atom_size(prefix, pos) {
            Some(s) => s,
            None => break,
        };
        if atom_size < 8 {
            break;
        }
        let atom_type = &prefix[pos + 4..pos + 8];
        if atom_type == b"mdat" {
            saw_mdat = true;
        }
        if atom_type == b"moov" {
            saw_moov = true;
            break;
        }
        let advance = atom_size.min((prefix.len() - pos) as u64) as usize;
        if advance < 8 {
            break;
        }
        pos += advance;
    }
    saw_mdat && !saw_moov
}

/// Scan `[scan_start, scan_end)` for a top-level atom fourcc (e.g. `moov`).
fn find_atom_fourcc(data: &[u8], atom: &[u8; 4], scan_start: usize, scan_end: usize) -> Option<usize> {
    let end = scan_end.min(data.len());
    let start = scan_start.min(end);
    for i in start..end.saturating_sub(8) {
        if data[i + 4..i + 8] == *atom {
            return Some(i);
        }
    }
    None
}

/// `moov` in the last 8 MiB (moov-at-end) or anywhere in the first 32 MiB (fast-start).
pub(crate) fn mp4_has_moov_atom(data: &[u8]) -> bool {
    if data.len() < 16 {
        return false;
    }
    const TAIL_SCAN: usize = 8 * 1024 * 1024;
    const PREFIX_SCAN: usize = 32 * 1024 * 1024;
    if find_atom_fourcc(data, b"moov", data.len().saturating_sub(TAIL_SCAN), data.len()).is_some() {
        return true;
    }
    find_atom_fourcc(data, b"moov", 0, PREFIX_SCAN.min(data.len())).is_some()
}

/// `ftyp` in the first few KB — minimal sanity check for ISO-BMFF from ranged assembly.
pub(crate) fn mp4_has_ftyp_atom(data: &[u8]) -> bool {
    find_atom_fourcc(data, b"ftyp", 0, data.len().min(8192)).is_some()
}

/// After a full ranged download, the buffer should contain `ftyp` and `moov`.
pub(crate) fn isobmff_buffer_looks_complete(data: &[u8]) -> bool {
    mp4_has_ftyp_atom(data) && mp4_has_moov_atom(data)
}

/// Heuristic: large runs of zero bytes between `ftyp` and `moov` suggest a sparse/holey
/// ranged buffer (tail prefetch + incomplete linear fill) rather than real audio.
pub(crate) fn mp4_suspect_zero_holes(data: &[u8]) -> bool {
    if data.len() < 256 * 1024 {
        return false;
    }
    let moov_off = find_atom_fourcc(data, b"moov", data.len().saturating_sub(8 * 1024 * 1024), data.len())
        .or_else(|| find_atom_fourcc(data, b"moov", 0, data.len().min(32 * 1024 * 1024)));
    let Some(moov_off) = moov_off else {
        return false;
    };
    let scan_end = moov_off.min(data.len());
    let scan_start = 64 * 1024; // skip tiny header
    if scan_end <= scan_start + 64 * 1024 {
        return false;
    }
    const BLOCK: usize = 64 * 1024;
    let mut zero_blocks = 0usize;
    let mut total_blocks = 0usize;
    let mut pos = scan_start;
    while pos + BLOCK <= scan_end {
        total_blocks += 1;
        if data[pos..pos + BLOCK].iter().all(|&b| b == 0) {
            zero_blocks += 1;
        }
        pos += BLOCK;
    }
    total_blocks > 4 && zero_blocks * 100 / total_blocks >= 10
}

/// Log why Symphonia may reject a buffer (for support / debugging).
pub(crate) fn log_isobmff_buffer_diagnostic(data: &[u8], hint: Option<&str>, label: &str) {
    let prefix_hex: String = data
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let looks_json = data.starts_with(b"{") || data.starts_with(b"[");
    crate::app_eprintln!(
        "[stream] ISO-BMFF diagnostic ({label}): hint={:?} bytes={} prefix=[{}] json_like={} ftyp={} moov={} zero_holes={}",
        hint,
        data.len(),
        prefix_hex,
        looks_json,
        mp4_has_ftyp_atom(data),
        mp4_has_moov_atom(data),
        mp4_suspect_zero_holes(data),
    );
}

fn read_mp4_atom_size(data: &[u8], pos: usize) -> Option<u64> {
    if pos + 8 > data.len() {
        return None;
    }
    let size32 = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as u64;
    if size32 == 1 {
        if pos + 16 > data.len() {
            return None;
        }
        Some(u64::from_be_bytes(data[pos + 8..pos + 16].try_into().ok()?))
    } else {
        Some(size32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(typ: &[u8; 4], payload_len: usize) -> Vec<u8> {
        let size = (8 + payload_len) as u32;
        let mut v = Vec::with_capacity(8 + payload_len);
        v.extend_from_slice(&size.to_be_bytes());
        v.extend_from_slice(typ);
        v.resize(8 + payload_len, 0);
        v
    }

    #[test]
    fn moov_after_mdat_detected() {
        let mut buf = Vec::new();
        buf.extend(atom(b"ftyp", 4));
        buf.extend(atom(b"mdat", 100));
        buf.extend(atom(b"moov", 40));
        assert!(mp4_moov_follows_mdat(&buf));
        assert!(mp4_needs_tail_prefetch(&buf, Some("m4a")));
    }

    #[test]
    fn moov_before_mdat_no_tail_prefetch() {
        let mut buf = Vec::new();
        buf.extend(atom(b"ftyp", 4));
        buf.extend(atom(b"moov", 40));
        buf.extend(atom(b"mdat", 100));
        assert!(!mp4_moov_follows_mdat(&buf));
        assert!(!mp4_needs_tail_prefetch(&buf, Some("m4a")));
    }

    #[test]
    fn empty_prefix_with_m4a_hint_needs_tail_prefetch() {
        assert!(mp4_needs_tail_prefetch(&[], Some("m4a")));
    }

    #[test]
    fn empty_prefix_without_mp4_hint_skips_tail_prefetch() {
        assert!(!mp4_needs_tail_prefetch(&[], Some("mp3")));
        assert!(!mp4_needs_tail_prefetch(&[], None));
    }

    #[test]
    fn isobmff_complete_detects_ftyp_and_moov() {
        let mut buf = Vec::new();
        buf.extend(atom(b"ftyp", 4));
        buf.extend(atom(b"mdat", 200));
        buf.extend(atom(b"moov", 40));
        assert!(isobmff_buffer_looks_complete(&buf));
        assert!(!mp4_suspect_zero_holes(&buf));
    }

    #[test]
    fn isobmff_incomplete_without_moov() {
        let mut buf = Vec::new();
        buf.extend(atom(b"ftyp", 4));
        buf.extend(atom(b"mdat", 200));
        assert!(!isobmff_buffer_looks_complete(&buf));
    }
}
