use super::*;

// ── is_publishable_image_url ─────────────────────────────────────────────

#[test]
fn publishable_url_accepts_public_share_image_link() {
    assert!(is_publishable_image_url(
        "https://music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEifQ.abc?size=600"
    ));
}

#[test]
fn publishable_url_accepts_itunes_artwork_link() {
    assert!(is_publishable_image_url(
        "https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg"
    ));
}

#[test]
fn publishable_url_rejects_credentialed_subsonic_cover_url() {
    assert!(!is_publishable_image_url(
        "https://music.example.com/rest/getCoverArt.view?id=al-1&u=alice&t=deadbeef&s=abc123"
    ));
}

#[test]
fn publishable_url_rejects_credentialed_url_regardless_of_key_case() {
    assert!(!is_publishable_image_url(
        "https://music.example.com/rest/getCoverArt.view?id=al-1&U=alice&T=deadbeef&S=abc123"
    ));
}

#[test]
fn publishable_url_rejects_non_https_scheme() {
    assert!(!is_publishable_image_url(
        "http://music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.abc"
    ));
}

#[test]
fn publishable_url_rejects_embedded_userinfo() {
    assert!(!is_publishable_image_url(
        "https://alice:secret@music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.abc"
    ));
}

#[test]
fn publishable_url_rejects_malformed_url() {
    assert!(!is_publishable_image_url("not a url"));
}

#[test]
fn publishable_url_rejects_lan_host() {
    assert!(!is_publishable_image_url(
        "https://192.168.1.5/share/img/eyJhbGciOiJIUzI1NiJ9.abc"
    ));
}

#[test]
fn publishable_url_rejects_loopback_and_local_hosts() {
    assert!(!is_publishable_image_url("https://localhost/share/img/abc"));
    assert!(!is_publishable_image_url(
        "https://music.local/share/img/abc"
    ));
}
