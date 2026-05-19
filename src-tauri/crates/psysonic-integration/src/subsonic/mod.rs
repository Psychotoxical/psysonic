//! Subsonic REST client — read-only endpoints the library-sync engine
//! consumes (phase B per spec §10). See `client::SubsonicClient` for the
//! entry point.

pub mod auth;
pub mod client;
pub mod error;
pub mod types;

pub use auth::SubsonicCredentials;
pub use client::{
    fingerprint_sample, SubsonicClient, SUBSONIC_API_VERSION, SUBSONIC_CLIENT_ID,
};
pub use error::SubsonicError;
pub use types::{
    Album, AlbumSummary, ArtistIndex, ArtistRef, IndexBucket, ScanStatus, SearchResult, ServerInfo,
    Song,
};
