use super::get_embedded_lyrics;
use std::path::{Path, PathBuf};

/// An Enhanced LRC body: a line stamp plus inline `<mm:ss.xx>` word stamps.
const ENHANCED_LRC: &str = "[00:12.00]<00:12.00>Hello <00:12.90>world";

/// Minimal MPEG-1 Layer III frame header plus padding — enough for lofty to
/// identify the file as MPEG. The audio itself is never decoded here.
fn write_fake_mp3(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut bytes = vec![0xFF, 0xFB, 0x90, 0x64];
    bytes.extend(std::iter::repeat_n(0u8, 512));
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A FLAC stream with nothing but a STREAMINFO block: 44.1 kHz, stereo,
/// 16-bit, no audio frames.
fn write_minimal_flac(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut bytes = b"fLaC".to_vec();
    bytes.push(0x80); // last-metadata-block flag + block type 0 (STREAMINFO)
    bytes.extend_from_slice(&[0x00, 0x00, 0x22]); // block length = 34
    let mut streaminfo = [0u8; 34];
    streaminfo[0..2].copy_from_slice(&4096u16.to_be_bytes()); // min block size
    streaminfo[2..4].copy_from_slice(&4096u16.to_be_bytes()); // max block size
                                                              // sample rate (20 bits) | channels-1 (3) | bits-per-sample-1 (5) | total samples (36)
    streaminfo[10] = 0x0A;
    streaminfo[11] = 0xC4;
    streaminfo[12] = 0x42;
    streaminfo[13] = 0xF0;
    bytes.extend_from_slice(&streaminfo);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn write_flac_comment(dir: &Path, name: &str, key: &str, value: &str) -> PathBuf {
    use lofty::config::WriteOptions;
    use lofty::ogg::VorbisComments;
    use lofty::prelude::TagExt;

    let path = write_minimal_flac(dir, name);
    let mut comments = VorbisComments::default();
    comments.push(key.to_owned(), value.to_owned());
    comments
        .save_to_path(&path, WriteOptions::default())
        .unwrap();
    path
}

#[test]
fn uslt_enhanced_lrc_is_returned_verbatim() {
    use id3::{frame::Lyrics, Content, Frame, Tag, TagLike, Version};

    let dir = tempfile::tempdir().unwrap();
    let path = write_fake_mp3(dir.path(), "uslt.mp3");

    let mut tag = Tag::new();
    tag.add_frame(Frame::with_content(
        "USLT",
        Content::Lyrics(Lyrics {
            lang: "eng".into(),
            description: String::new(),
            text: ENHANCED_LRC.into(),
        }),
    ));
    tag.write_to_path(&path, Version::Id3v24).unwrap();

    // The inline word stamps must survive the read untouched — the frontend
    // parser is what turns them into word timing.
    let got = get_embedded_lyrics(path.to_string_lossy().into_owned());
    assert_eq!(got.as_deref(), Some(ENHANCED_LRC));
}

#[test]
fn sylt_is_rebuilt_as_line_level_lrc_and_can_carry_no_word_stamps() {
    use id3::{
        frame::{SynchronisedLyrics, SynchronisedLyricsType, TimestampFormat},
        Content, Frame, Tag, TagLike, Version,
    };

    let dir = tempfile::tempdir().unwrap();
    let path = write_fake_mp3(dir.path(), "sylt.mp3");

    let mut tag = Tag::new();
    tag.add_frame(Frame::with_content(
        "SYLT",
        Content::SynchronisedLyrics(SynchronisedLyrics {
            lang: "eng".into(),
            timestamp_format: TimestampFormat::Ms,
            content_type: SynchronisedLyricsType::Lyrics,
            description: String::new(),
            content: vec![(12_000, "Hello world".into()), (74_500, "bye".into())],
        }),
    ));
    tag.write_to_path(&path, Version::Id3v24).unwrap();

    let got = get_embedded_lyrics(path.to_string_lossy().into_owned()).unwrap();
    assert_eq!(got, "[00:12.00]Hello world\n[01:14.50]bye");
    // SYLT timestamps are per line, so this source can never carry word timing.
    assert!(!got.contains('<'));
}

#[test]
fn vorbis_synced_lyrics_is_returned_verbatim() {
    // Regression: `SYNCEDLYRICS` is not a key lofty knows, so reading it off
    // the generic tag always failed and the file looked lyrics-free.
    let dir = tempfile::tempdir().unwrap();
    let path = write_flac_comment(dir.path(), "synced.flac", "SYNCEDLYRICS", ENHANCED_LRC);

    let got = get_embedded_lyrics(path.to_string_lossy().into_owned());
    assert_eq!(got.as_deref(), Some(ENHANCED_LRC));
}

#[test]
fn vorbis_lyrics_field_is_returned_verbatim() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_flac_comment(dir.path(), "lyrics.flac", "LYRICS", ENHANCED_LRC);

    let got = get_embedded_lyrics(path.to_string_lossy().into_owned());
    assert_eq!(got.as_deref(), Some(ENHANCED_LRC));
}

#[test]
fn vorbis_synced_lyrics_wins_over_plain_lyrics() {
    use lofty::config::WriteOptions;
    use lofty::ogg::VorbisComments;
    use lofty::prelude::TagExt;

    let dir = tempfile::tempdir().unwrap();
    let path = write_minimal_flac(dir.path(), "both.flac");
    let mut comments = VorbisComments::default();
    comments.push("SYNCEDLYRICS".to_owned(), ENHANCED_LRC.to_owned());
    comments.push("LYRICS".to_owned(), "plain fallback".to_owned());
    comments
        .save_to_path(&path, WriteOptions::default())
        .unwrap();

    let got = get_embedded_lyrics(path.to_string_lossy().into_owned());
    assert_eq!(got.as_deref(), Some(ENHANCED_LRC));
}

#[test]
fn missing_file_yields_none() {
    assert!(get_embedded_lyrics("does/not/exist.mp3".into()).is_none());
}
