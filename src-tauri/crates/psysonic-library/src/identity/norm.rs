//! Identity-string normalization for cluster keys (spec §3.1, TEXT not hash).
//!
//! `norm(s)`: Unicode NFD → drop combining marks → lowercase → letters/digits only.
//! Empty after normalization → `None` (key is NULL; track never merges).
//!
//! Diacritic folding is driven by an in-crate decomposition table (dependency-free),
//! so it must be kept in step with the languages the app actually ships as UI
//! locales (`src/locales/*`). The table currently covers the Latin scripts
//! (incl. German ß→ss, Norwegian/Danish æ→ae, French œ→oe, Romanian comma-below
//! ș/ț) and the Cyrillic folds (ru/bg: ё→е, й→и). CJK locales (ja, zh) are left
//! intact on purpose — Han/Kana are kept verbatim and Japanese dakuten are
//! phonemic, so they must NOT be stripped.
//!
//! WHEN ADDING A NEW UI LOCALE: audit this table for that language's letters and
//! extend it if any diacritic/ligature would otherwise not fold (then bump
//! `NORM_VERSION` so existing cluster keys rebuild). See the i18n locale-adding
//! guide for the checklist entry that points here.

/// Separator for composite keys — U+001F cannot appear in normalized output.
pub(crate) const KEY_SEP: char = '\u{001f}';

/// Bump when normalization rules change; stored in `cluster.cluster_meta.norm_version`.
/// v2: locale-aware folding (ß→ss, æ→ae, œ→oe, Romanian ș/ț, Cyrillic ё/й).
pub const NORM_VERSION: &str = "2";

/// Normalize one identity field. Returns `None` when input is empty/whitespace-only
/// or when normalization strips everything (punctuation-only, etc.).
pub fn norm_part(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    for c in decompose_canonical(trimmed.chars()) {
        if is_combining_mark(c) {
            continue;
        }
        for lc in c.to_lowercase() {
            if lc.is_alphanumeric() {
                out.push(lc);
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Join normalized parts; any missing part → composite key is `None`.
pub fn join_norm_parts(parts: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let mut joined = String::new();
    let mut count = 0usize;
    for part in parts {
        let p = part?;
        if count > 0 {
            joined.push(KEY_SEP);
        }
        joined.push_str(&p);
        count += 1;
    }
    if count == 0 {
        None
    } else {
        Some(joined)
    }
}

fn is_combining_mark(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

/// Expand to canonical NFD using left-to-right iterative decomposition (dependency-free).
fn decompose_canonical(chars: impl IntoIterator<Item = char>) -> Vec<char> {
    let mut work: Vec<char> = chars.into_iter().collect();
    let mut idx = 0;
    while idx < work.len() {
        let c = work[idx];
        if let Some(parts) = canonical_decomposition(c) {
            work.splice(idx..idx + 1, parts);
        } else {
            idx += 1;
        }
    }
    work
}

/// Canonical single-char decomposition for the shipped UI-locale scripts
/// (Latin incl. ligatures + Romanian comma-below, and Cyrillic ё/й). Unmapped
/// chars — notably CJK — pass through untouched. Keep in sync with `src/locales/*`.
fn canonical_decomposition(c: char) -> Option<Vec<char>> {
    let cp = c as u32;
    let (base, mark) = match cp {
        0x00C0 | 0x00E0 => ('A', '\u{0300}'),
        0x00C1 | 0x00E1 => ('A', '\u{0301}'),
        0x00C2 | 0x00E2 => ('A', '\u{0302}'),
        0x00C3 | 0x00E3 => ('A', '\u{0303}'),
        0x00C4 | 0x00E4 => ('A', '\u{0308}'),
        0x00C5 | 0x00E5 => ('A', '\u{030A}'),
        0x00C6 => return Some(vec!['A', 'E']),
        0x00E6 => return Some(vec!['a', 'e']),
        0x00C7 | 0x00E7 => ('C', '\u{0327}'),
        0x00C8 | 0x00E8 => ('E', '\u{0300}'),
        0x00C9 | 0x00E9 => ('E', '\u{0301}'),
        0x00CA | 0x00EA => ('E', '\u{0302}'),
        0x00CB | 0x00EB => ('E', '\u{0308}'),
        0x00CC | 0x00EC => ('I', '\u{0300}'),
        0x00CD | 0x00ED => ('I', '\u{0301}'),
        0x00CE | 0x00EE => ('I', '\u{0302}'),
        0x00CF | 0x00EF => ('I', '\u{0308}'),
        0x00D0 => ('D', '\u{0330}'),
        0x00F0 => ('d', '\u{0330}'),
        0x00D1 | 0x00F1 => ('N', '\u{0303}'),
        0x00D2 | 0x00F2 => ('O', '\u{0300}'),
        0x00D3 | 0x00F3 => ('O', '\u{0301}'),
        0x00D4 | 0x00F4 => ('O', '\u{0302}'),
        0x00D5 | 0x00F5 => ('O', '\u{0303}'),
        0x00D6 | 0x00F6 => ('O', '\u{0308}'),
        0x00D8 | 0x00F8 => ('O', '\u{0338}'),
        0x00D9 | 0x00F9 => ('U', '\u{0300}'),
        0x00DA | 0x00FA => ('U', '\u{0301}'),
        0x00DB | 0x00FB => ('U', '\u{0302}'),
        0x00DC | 0x00FC => ('U', '\u{0308}'),
        0x00DD | 0x00FD => ('Y', '\u{0301}'),
        0x00DF => return Some(vec!['s', 's']),
        0x0100 | 0x0101 => ('A', '\u{0304}'),
        0x0102 | 0x0103 => ('A', '\u{0306}'),
        0x0104 | 0x0105 => ('A', '\u{0328}'),
        0x0106 | 0x0107 => ('C', '\u{0301}'),
        0x0108 | 0x0109 => ('C', '\u{0302}'),
        0x010A | 0x010B => ('C', '\u{0307}'),
        0x010C | 0x010D => ('C', '\u{030C}'),
        0x010E | 0x010F => ('D', '\u{030C}'),
        0x0110 | 0x0111 => ('D', '\u{0330}'),
        0x0112 | 0x0113 => ('E', '\u{0304}'),
        0x0114 | 0x0115 => ('E', '\u{0306}'),
        0x0116 | 0x0117 => ('E', '\u{0307}'),
        0x0118 | 0x0119 => ('E', '\u{0328}'),
        0x011A | 0x011B => ('E', '\u{030C}'),
        0x011C | 0x011D => ('G', '\u{0302}'),
        0x011E | 0x011F => ('G', '\u{0306}'),
        0x0120 | 0x0121 => ('G', '\u{0307}'),
        0x0122 | 0x0123 => ('G', '\u{0327}'),
        0x0124 | 0x0125 => ('H', '\u{0302}'),
        0x0126 | 0x0127 => ('H', '\u{0330}'),
        0x0128 | 0x0129 => ('I', '\u{0303}'),
        0x012A | 0x012B => ('I', '\u{0304}'),
        0x012C | 0x012D => ('I', '\u{0306}'),
        0x012E | 0x012F => ('I', '\u{0328}'),
        0x0130 => return Some(vec!['I', '\u{0307}']),
        0x0131 => return Some(vec!['i']),
        0x0132 => return Some(vec!['I', 'J']),
        0x0133 => return Some(vec!['i', 'j']),
        0x0134 | 0x0135 => ('J', '\u{0302}'),
        0x0136 | 0x0137 => ('K', '\u{0327}'),
        0x0139 | 0x013A => ('L', '\u{0301}'),
        0x013B | 0x013C => ('L', '\u{0327}'),
        0x013D | 0x013E => ('L', '\u{030C}'),
        0x0141 | 0x0142 => ('L', '\u{0330}'),
        0x0143 | 0x0144 => ('N', '\u{0301}'),
        0x0145 | 0x0146 => ('N', '\u{0327}'),
        0x0147 | 0x0148 => ('N', '\u{030C}'),
        0x014C | 0x014D => ('O', '\u{0304}'),
        0x014E | 0x014F => ('O', '\u{0306}'),
        0x0150 | 0x0151 => ('O', '\u{030B}'),
        0x0154 | 0x0155 => ('R', '\u{0301}'),
        0x0156 | 0x0157 => ('R', '\u{0327}'),
        0x0158 | 0x0159 => ('R', '\u{030C}'),
        0x015A | 0x015B => ('S', '\u{0301}'),
        0x015C | 0x015D => ('S', '\u{0302}'),
        0x015E | 0x015F => ('S', '\u{0327}'),
        0x0160 | 0x0161 => ('S', '\u{030C}'),
        0x0162 | 0x0163 => ('T', '\u{0327}'),
        0x0164 | 0x0165 => ('T', '\u{030C}'),
        0x0166 | 0x0167 => ('T', '\u{0330}'),
        0x0168 | 0x0169 => ('U', '\u{0303}'),
        0x016A | 0x016B => ('U', '\u{0304}'),
        0x016C | 0x016D => ('U', '\u{0306}'),
        0x016E | 0x016F => ('U', '\u{030A}'),
        0x0170 | 0x0171 => ('U', '\u{030B}'),
        0x0172 | 0x0173 => ('U', '\u{0328}'),
        0x0174 | 0x0175 => ('W', '\u{0302}'),
        0x0176 | 0x0177 => ('Y', '\u{0302}'),
        0x0178 => return Some(vec!['Y', '\u{0308}']),
        0x0179 | 0x017A => ('Z', '\u{0301}'),
        0x017B | 0x017C => ('Z', '\u{0307}'),
        0x017D | 0x017E => ('Z', '\u{030C}'),
        0x017F => return Some(vec!['s']),
        // French ligature œ (æ/ß handled above). Fold to the two-letter form.
        0x0152 => return Some(vec!['O', 'E']),
        0x0153 => return Some(vec!['o', 'e']),
        // Romanian comma-below (Latin Extended-B): Ș/ș, Ț/ț. Fold like the
        // cedilla forms above (U+0326 is dropped as a combining mark).
        0x0218 | 0x0219 => ('S', '\u{0326}'),
        0x021A | 0x021B => ('T', '\u{0326}'),
        // Cyrillic (ru, bg) canonical decompositions: Ё→Е (+diaeresis), Й→И
        // (+breve). The mark is dropped, so ё/е and й/и fold together — the
        // same diacritic-folding contract the Latin rows above provide.
        0x0401 | 0x0451 => ('\u{0415}', '\u{0308}'),
        0x0419 | 0x0439 => ('\u{0418}', '\u{0306}'),
        _ => return None,
    };
    let base_out = if c.is_uppercase() {
        base
    } else {
        base.to_lowercase().next().unwrap_or(base)
    };
    Some(vec![base_out, mark])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_strips_diacritics_case_and_punctuation() {
        assert_eq!(norm_part("Café"), Some("cafe".into()));
        assert_eq!(norm_part("AC/DC"), Some("acdc".into()));
        assert_eq!(norm_part("  Björk  "), Some("bjork".into()));
    }

    #[test]
    fn norm_folds_locale_ligatures() {
        // German ß → ss, Norwegian/Danish æ → ae, French œ → oe.
        assert_eq!(norm_part("Straße"), Some("strasse".into()));
        assert_eq!(norm_part("Blæst"), Some("blaest".into()));
        assert_eq!(norm_part("Cœur"), Some("coeur".into()));
    }

    #[test]
    fn norm_folds_romanian_comma_below() {
        assert_eq!(norm_part("Ștefan"), Some("stefan".into()));
        assert_eq!(norm_part("București"), Some("bucuresti".into()));
        assert_eq!(norm_part("Constanța"), Some("constanta".into()));
    }

    #[test]
    fn norm_folds_cyrillic_diacritics_but_keeps_base_letters() {
        // ё/й fold to е/и; other Cyrillic letters survive as lowercase.
        assert_eq!(norm_part("Фёдор"), norm_part("Федор"));
        assert_eq!(norm_part("Фёдор"), Some("федор".into()));
        assert_eq!(norm_part("Й"), Some("и".into()));
        assert_eq!(norm_part("Пётр Ильич"), Some("петрильич".into()));
    }

    #[test]
    fn norm_keeps_cjk_and_phonemic_kana() {
        // Han/Kanji kept verbatim (no wrongful folding).
        assert_eq!(norm_part("周杰倫"), Some("周杰倫".into()));
        assert_eq!(norm_part("久石譲"), Some("久石譲".into()));
        // Japanese dakuten is phonemic: が (ga) must NOT fold to か (ka).
        assert_ne!(norm_part("が"), norm_part("か"));
    }

    #[test]
    fn norm_empty_or_punctuation_only_is_none() {
        assert_eq!(norm_part(""), None);
        assert_eq!(norm_part("   "), None);
        assert_eq!(norm_part("..."), None);
        assert_eq!(norm_part("!!!"), None);
    }

    #[test]
    fn join_norm_parts_requires_all_parts() {
        assert_eq!(
            join_norm_parts([Some("a".into()), Some("b".into())]),
            Some(format!("a{}b", KEY_SEP))
        );
        assert_eq!(join_norm_parts([Some("a".into()), None]), None);
    }
}
