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
