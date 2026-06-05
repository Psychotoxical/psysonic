//! `psysonic-core` — workspace-internal shared primitives.
//!
//! Hosts the runtime logging facade (with `app_eprintln!` / `app_deprintln!`
//! macros) and the cross-crate port traits used to break dependency cycles
//! between `psysonic-audio`, `psysonic-analysis`, and other domain crates.

pub mod cover_cache_layout;
pub mod media_layout;
pub mod logging;
pub mod ports;
pub mod track_analysis;
pub mod track_enrichment;
pub mod user_agent;
