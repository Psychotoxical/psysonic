//! Shared parsing for Shoutcast/Icecast inline metadata blocks.

use std::borrow::Cow;

const STREAM_TITLE_TAG: &str = "StreamTitle='";
const STREAM_URL_TAG: &str = "StreamUrl='";

/// One decoded ICY metadata block.
///
/// ICY does not carry a reliable charset declaration. Valid UTF-8 is preserved;
/// otherwise each byte is mapped to its corresponding Latin-1 code point.
pub struct IcyMetadataBlock<'a> {
    text: Cow<'a, str>,
}

impl<'a> IcyMetadataBlock<'a> {
    pub fn parse(bytes: &'a [u8]) -> Self {
        let text = match std::str::from_utf8(bytes) {
            Ok(text) => Cow::Borrowed(text),
            Err(_) => Cow::Owned(bytes.iter().copied().map(char::from).collect()),
        };
        Self { text }
    }

    pub fn stream_title(&self) -> Option<&str> {
        self.field(STREAM_TITLE_TAG)
    }

    pub fn stream_url(&self) -> Option<&str> {
        self.field(STREAM_URL_TAG)
    }

    fn field(&self, tag: &str) -> Option<&str> {
        let text = self.text.trim_end_matches('\0');
        let value = text.split_once(tag)?.1;
        let end = find_field_end(value)?;
        let value = value[..end].trim();
        (!value.is_empty()).then_some(value)
    }
}

fn find_field_end(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    bytes.windows(2).enumerate().find_map(|(index, pair)| {
        (pair == b"';" && !is_escaped(bytes, index)).then_some(index)
    })
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    bytes[..index]
        .iter()
        .rev()
        .take_while(|&&byte| byte == b'\\')
        .count()
        % 2
        == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_title_and_url() {
        let metadata = IcyMetadataBlock::parse(
            b"StreamTitle='Pink Floyd - Time';StreamUrl='https://example.com';",
        );
        assert_eq!(metadata.stream_title(), Some("Pink Floyd - Time"));
        assert_eq!(metadata.stream_url(), Some("https://example.com"));
    }

    #[test]
    fn preserves_valid_utf8() {
        let title = "TimJamFer - \u{ff59}\u{ff4f}\u{ff55} \
                     \u{84b8}\u{6c17}\u{30bd}\u{30d5}\u{30c8} \
                     \u{d55c}\u{ae00}";
        let raw = format!("StreamTitle='{title}';StreamUrl='';");
        let metadata = IcyMetadataBlock::parse(raw.as_bytes());
        assert_eq!(metadata.stream_title(), Some(title));
    }

    #[test]
    fn falls_back_to_latin1_for_invalid_utf8() {
        let metadata =
            IcyMetadataBlock::parse(b"StreamTitle='\xA9 Track';StreamUrl='x';");
        assert_eq!(metadata.stream_title(), Some("\u{00a9} Track"));
    }

    #[test]
    fn tolerates_trailing_null_padding() {
        let metadata =
            IcyMetadataBlock::parse(b"StreamTitle='Track';StreamUrl='0';\0\0");
        assert_eq!(metadata.stream_title(), Some("Track"));
        assert_eq!(metadata.stream_url(), Some("0"));
    }

    #[test]
    fn ignores_escaped_field_terminator() {
        let metadata =
            IcyMetadataBlock::parse(b"StreamTitle='Rock \\'; Roll';StreamUrl='x';");
        assert_eq!(metadata.stream_title(), Some("Rock \\'; Roll"));
    }

    #[test]
    fn even_backslashes_do_not_escape_field_terminator() {
        let metadata = IcyMetadataBlock::parse(
            b"StreamTitle='Track \\\\';ignored';StreamUrl='x';",
        );
        assert_eq!(metadata.stream_title(), Some("Track \\\\"));
    }

    #[test]
    fn rejects_unterminated_or_empty_title() {
        assert_eq!(
            IcyMetadataBlock::parse(b"StreamTitle='no-end").stream_title(),
            None
        );
        assert_eq!(
            IcyMetadataBlock::parse(b"StreamTitle='';StreamUrl='x';").stream_title(),
            None
        );
    }
}
