//! Subsonic REST client — read-only endpoints the library-sync engine
//! consumes (phase B per spec §10). See `client::SubsonicClient` for the
//! entry point.

pub mod auth;
pub mod client;
pub mod error;
pub mod stream_url;
pub mod types;

pub use auth::SubsonicCredentials;
pub use client::{
    fingerprint_sample, subsonic_client_with_registry, SubsonicClient, SUBSONIC_API_VERSION,
    SUBSONIC_CLIENT_ID,
};
pub use stream_url::{build_stream_view_url, rest_base_from_url};
pub use error::SubsonicError;
pub use types::{
    Album, AlbumSummary, ArtistIndex, ArtistRef, IndexBucket, MusicFolder, ScanStatus,
    SearchResult, ServerInfo, Song,
};
