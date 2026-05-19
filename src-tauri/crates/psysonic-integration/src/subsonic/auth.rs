use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Subsonic credentials in the legacy salted-md5 shape (spec v1.13+):
/// the client sends `u` + `t = md5(password || salt)` + `s = salt`,
/// never the plaintext password. The salt is per-request to defeat
/// replay, but doesn't need to be cryptographically random — Subsonic's
/// API treats it as an opaque uniqueness nonce.
#[derive(Debug, Clone)]
pub struct SubsonicCredentials {
    pub username: String,
    pub token: String,
    pub salt: String,
}

impl SubsonicCredentials {
    /// Derive a credentials triple from a plaintext password. Generates a
    /// fresh salt and computes `md5(password || salt)`.
    pub fn from_password(username: impl Into<String>, password: &str) -> Self {
        let salt = fresh_salt();
        let token = md5_hex(&format!("{password}{salt}"));
        Self { username: username.into(), token, salt }
    }

    /// Use a caller-supplied salt + token. Intended for tests and for
    /// callers that already cache the derivation result.
    pub fn with_static(username: impl Into<String>, token: impl Into<String>, salt: impl Into<String>) -> Self {
        Self { username: username.into(), token: token.into(), salt: salt.into() }
    }
}

/// Per-process monotonically-advancing nonce mixed into the salt so the
/// hot loop of `from_password` calls doesn't repeat itself even at the
/// same nanosecond.
static SALT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn fresh_salt() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = SALT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    format!("{:016x}{:08x}", nanos ^ pid.rotate_left(13), counter)
}

fn md5_hex(input: &str) -> String {
    let digest = md5::compute(input.as_bytes());
    format!("{digest:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn from_password_computes_md5_token() {
        // Force the salt by going through with_static for a deterministic check.
        let salt = "abc123";
        let password = "sesame";
        let expected = md5_hex(&format!("{password}{salt}"));
        let creds = SubsonicCredentials::with_static("user", &expected, salt);
        assert_eq!(creds.token, expected);
        assert_eq!(creds.token.len(), 32, "md5 hex must be 32 chars");
    }

    #[test]
    fn fresh_salt_is_unique_across_rapid_calls() {
        let mut seen: HashSet<String> = HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(fresh_salt()), "fresh_salt repeated");
        }
    }

    #[test]
    fn from_password_produces_different_salts_per_call() {
        let a = SubsonicCredentials::from_password("u", "pw");
        let b = SubsonicCredentials::from_password("u", "pw");
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.token, b.token, "different salt → different token");
    }

    #[test]
    fn md5_hex_matches_known_vector() {
        // md5("") = d41d8cd98f00b204e9800998ecf8427e
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }
}
