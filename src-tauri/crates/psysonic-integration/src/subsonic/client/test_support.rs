use super::{SubsonicClient, SubsonicCredentials};

pub(super) fn test_credentials() -> SubsonicCredentials {
    SubsonicCredentials::with_static("user", "deadbeef", "saltsalt")
}

pub(super) fn test_client(uri: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(uri, test_credentials(), reqwest::Client::new())
}
