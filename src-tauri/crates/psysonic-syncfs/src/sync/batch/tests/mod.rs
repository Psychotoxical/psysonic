use super::*;

fn write_file(path: &std::path::Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

fn fake_auth(base_url: String) -> SubsonicAuthPayload {
    SubsonicAuthPayload {
        base_url,
        u: "user".into(),
        t: "abc".into(),
        s: "salt".into(),
        v: "1.16.1".into(),
        c: "psysonic".into(),
        f: "json".into(),
        server_id: "server-id".into(),
        server_index_key: "server.test".into(),
    }
}

mod filesystem;
mod source_identity;
mod subsonic;
mod track_mapping;
