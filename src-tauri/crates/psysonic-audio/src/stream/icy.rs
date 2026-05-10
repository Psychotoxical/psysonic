//! ICY (Shoutcast/Icecast) inline-metadata state machine.
//!
//! Streams embed metadata every `metaint` audio bytes:
//!
//!   ┌──────────────────────┬───┬─────────────┐
//!   │  audio × metaint     │ N │ meta × N×16 │  (repeating)
//!   └──────────────────────┴───┴─────────────┘
//!
//! N = 0 → no metadata this block.  Metadata bytes are stripped so only
//! pure audio reaches the ring buffer and Symphonia never sees text bytes.

#[allow(clippy::enum_variant_names)]
pub(crate) enum IcyState {
    /// Forwarding audio bytes; `remaining` counts down to the next boundary.
    ReadingAudio { remaining: usize },
    /// Next byte is the metadata length multiplier N.
    ReadingLengthByte,
    /// Accumulating N×16 metadata bytes.
    ReadingMetadata { remaining: usize, buf: Vec<u8> },
}

pub(crate) struct IcyInterceptor {
    state: IcyState,
    metaint: usize,
}

impl IcyInterceptor {
    pub(crate) fn new(metaint: usize) -> Self {
        Self { metaint, state: IcyState::ReadingAudio { remaining: metaint } }
    }

    /// Feed a raw HTTP chunk.
    /// Appends only audio bytes to `audio_out`.
    /// Returns `Some(IcyMeta)` when a StreamTitle is extracted.
    pub(crate) fn process(&mut self, input: &[u8], audio_out: &mut Vec<u8>) -> Option<IcyMeta> {
        let mut extracted: Option<IcyMeta> = None;
        let mut i = 0;
        while i < input.len() {
            match &mut self.state {
                IcyState::ReadingAudio { remaining } => {
                    let n = (input.len() - i).min(*remaining);
                    audio_out.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        self.state = IcyState::ReadingLengthByte;
                    }
                }
                IcyState::ReadingLengthByte => {
                    let len_n = input[i] as usize;
                    i += 1;
                    self.state = if len_n == 0 {
                        IcyState::ReadingAudio { remaining: self.metaint }
                    } else {
                        IcyState::ReadingMetadata {
                            remaining: len_n * 16,
                            buf: Vec::with_capacity(len_n * 16),
                        }
                    };
                }
                IcyState::ReadingMetadata { remaining, buf } => {
                    let n = (input.len() - i).min(*remaining);
                    buf.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        let bytes = std::mem::take(buf);
                        extracted = parse_icy_meta(&bytes);
                        self.state = IcyState::ReadingAudio { remaining: self.metaint };
                    }
                }
            }
        }
        extracted
    }
}

/// ICY metadata parsed from a raw metadata block.
#[derive(serde::Serialize, Clone)]
pub(crate) struct IcyMeta {
    pub title: String,
    /// `true` when `StreamUrl='0'` — indicates a CDN-injected ad/promo.
    pub is_ad: bool,
}

/// Extract `StreamTitle` and `StreamUrl` from a raw ICY metadata block.
/// Tolerates null padding and non-UTF-8 bytes (lossy conversion).
fn parse_icy_meta(raw: &[u8]) -> Option<IcyMeta> {
    let s = String::from_utf8_lossy(raw);
    let s = s.trim_end_matches('\0');

    const TITLE_TAG: &str = "StreamTitle='";
    let title_start = s.find(TITLE_TAG)? + TITLE_TAG.len();
    let title_rest = &s[title_start..];
    // find (not rfind) — rfind would skip past StreamUrl and corrupt the title
    let title_end = title_rest.find("';")?;
    let title = title_rest[..title_end].trim().to_string();
    if title.is_empty() {
        return None;
    }

    const URL_TAG: &str = "StreamUrl='";
    let stream_url = s.find(URL_TAG).map(|pos| {
        let rest = &s[pos + URL_TAG.len()..];
        let end = rest.find("';").unwrap_or(rest.len());
        rest[..end].trim().to_string()
    }).unwrap_or_default();

    Some(IcyMeta { title, is_ad: stream_url == "0" })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_icy_meta ────────────────────────────────────────────────────────

    #[test]
    fn parse_extracts_title_from_canonical_block() {
        let raw = b"StreamTitle='Pink Floyd - Time';StreamUrl='https://www.example';";
        let m = parse_icy_meta(raw).unwrap();
        assert_eq!(m.title, "Pink Floyd - Time");
        assert!(!m.is_ad);
    }

    #[test]
    fn parse_marks_is_ad_when_stream_url_is_zero() {
        let raw = b"StreamTitle='Sponsored';StreamUrl='0';";
        let m = parse_icy_meta(raw).unwrap();
        assert!(m.is_ad);
    }

    #[test]
    fn parse_returns_none_when_title_tag_missing() {
        assert!(parse_icy_meta(b"StreamUrl='abc';").is_none());
    }

    #[test]
    fn parse_returns_none_when_title_unterminated() {
        // Missing the closing `';` after StreamTitle.
        assert!(parse_icy_meta(b"StreamTitle='no-end").is_none());
    }

    #[test]
    fn parse_returns_none_when_title_is_empty() {
        assert!(parse_icy_meta(b"StreamTitle='';StreamUrl='x';").is_none());
    }

    #[test]
    fn parse_tolerates_trailing_null_padding() {
        let mut raw = b"StreamTitle='Track';StreamUrl='https://x';".to_vec();
        raw.extend_from_slice(&[0u8; 32]);
        let m = parse_icy_meta(&raw).unwrap();
        assert_eq!(m.title, "Track");
    }

    #[test]
    fn parse_tolerates_non_utf8_bytes() {
        // Latin-1 0xA9 (©) — String::from_utf8_lossy replaces with U+FFFD
        // and trim() leaves the title intact.
        let raw = b"StreamTitle='\xA9 Track';StreamUrl='x';";
        let m = parse_icy_meta(raw).unwrap();
        assert!(m.title.contains("Track"));
    }

    #[test]
    fn parse_uses_first_title_quote_pair_not_stream_url_pair() {
        // The body uses `find` not `rfind` so the title stops at its own `';`
        // even though a later `';` exists for StreamUrl.
        let raw = b"StreamTitle='Real Title';StreamUrl='Long URL with quotes';";
        let m = parse_icy_meta(raw).unwrap();
        assert_eq!(m.title, "Real Title");
    }

    // ── IcyInterceptor ────────────────────────────────────────────────────────

    #[test]
    fn interceptor_passes_audio_through_when_no_metadata_block_yet() {
        let mut icy = IcyInterceptor::new(8);
        let mut audio = Vec::new();
        let result = icy.process(b"abcd", &mut audio);
        assert_eq!(audio, b"abcd");
        assert!(result.is_none());
    }

    #[test]
    fn interceptor_strips_zero_length_metadata_block() {
        // metaint = 4, then 1 length byte = 0 → no metadata, then more audio.
        let mut icy = IcyInterceptor::new(4);
        let mut audio = Vec::new();
        // Audio (4) + length=0 + audio (4) = 9 bytes input
        let input: Vec<u8> = b"AAAA\x00BBBB".to_vec();
        let result = icy.process(&input, &mut audio);
        assert_eq!(audio, b"AAAABBBB");
        assert!(result.is_none(), "zero-length metadata block produces no IcyMeta");
    }

    #[test]
    fn interceptor_strips_metadata_bytes_from_audio_stream() {
        // metaint = 4, length=1 (×16=16 bytes of metadata).
        let mut icy = IcyInterceptor::new(4);
        let mut audio = Vec::new();
        let mut input = b"AAAA\x01".to_vec();
        // Pad metadata to exactly 16 bytes with a parsable StreamTitle.
        let mut meta = b"StreamTitle='X';".to_vec();
        meta.resize(16, 0);
        input.extend_from_slice(&meta);
        input.extend_from_slice(b"BBBB");

        let result = icy.process(&input, &mut audio);
        assert_eq!(audio, b"AAAABBBB", "metadata bytes do not leak into audio");
        let meta = result.expect("StreamTitle present");
        assert_eq!(meta.title, "X");
    }

    #[test]
    fn interceptor_handles_input_split_across_multiple_calls() {
        // Same scenario as above, fed in 1-byte chunks.
        let mut icy = IcyInterceptor::new(4);
        let mut audio = Vec::new();
        let mut full = b"AAAA\x01".to_vec();
        let mut meta = b"StreamTitle='Y';".to_vec();
        meta.resize(16, 0);
        full.extend_from_slice(&meta);
        full.extend_from_slice(b"BBBB");

        let mut last_meta = None;
        for byte in &full {
            if let Some(m) = icy.process(&[*byte], &mut audio) {
                last_meta = Some(m);
            }
        }
        assert_eq!(audio, b"AAAABBBB");
        assert_eq!(last_meta.unwrap().title, "Y");
    }

    #[test]
    fn interceptor_treats_subsequent_blocks_independently() {
        // Two metaint cycles, both with parsable metadata. Titles must be
        // single-character so `StreamTitle='X';` fits in the 16-byte block
        // (length byte = 1 → 16 bytes of metadata).
        let mut icy = IcyInterceptor::new(2);
        let mut audio = Vec::new();
        // First block: AA + length=1 + 16-byte meta
        let mut input = b"AA\x01".to_vec();
        input.extend_from_slice(b"StreamTitle='1';"); // exactly 16 bytes
        // Second block: BB + length=1 + 16-byte meta
        input.extend_from_slice(b"BB\x01");
        input.extend_from_slice(b"StreamTitle='2';"); // exactly 16 bytes
        // Trailing audio
        input.extend_from_slice(b"CC");

        let _ = icy.process(&input, &mut audio);
        assert_eq!(audio, b"AABBCC", "all audio bytes survive across two cycles");

        // Title verification with split input: a single process() returns at
        // most one IcyMeta, so feed the two metadata blocks in separate calls.
        let mut icy2 = IcyInterceptor::new(2);
        let mut audio2 = Vec::new();
        let split_at = 2 + 1 + 16; // end of first block
        let mut titles = Vec::new();
        if let Some(m) = icy2.process(&input[..split_at], &mut audio2) {
            titles.push(m.title);
        }
        if let Some(m) = icy2.process(&input[split_at..], &mut audio2) {
            titles.push(m.title);
        }
        assert_eq!(titles, vec!["1".to_string(), "2".to_string()]);
    }
}
