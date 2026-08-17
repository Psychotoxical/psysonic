//! `InitialSyncRunner` — spec §6.3 IS-1 … IS-7.
//!
//! This module remains the stable facade for the initial-sync runner while the
//! strategy loops and finalization passes live in focused child modules.

mod bulk_ingest;
mod common;
mod final_passes;
mod n1;
mod runner;
mod s1;
mod s2;

pub use runner::{InitialSyncReport, InitialSyncRunner};

#[cfg(test)]
mod tests;
