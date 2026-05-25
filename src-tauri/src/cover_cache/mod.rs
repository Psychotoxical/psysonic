//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B+).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureResult {
    pub hit: bool,
    pub path: String,
    pub tier: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheStatsDto {
    pub bytes: u64,
    pub count: u64,
}

#[tauri::command]
pub fn cover_cache_ensure() -> Result<CoverCacheEnsureResult, String> {
    Ok(CoverCacheEnsureResult {
        hit: false,
        path: String::new(),
        tier: 0,
    })
}

#[tauri::command]
pub fn cover_cache_ensure_batch() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn cover_cache_stats() -> Result<CoverCacheStatsDto, String> {
    Ok(CoverCacheStatsDto { bytes: 0, count: 0 })
}

#[tauri::command]
pub fn cover_cache_evict_tick() -> Result<u32, String> {
    Ok(0)
}

#[tauri::command]
pub fn cover_cache_clear() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn library_cover_backfill_batch() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "coverIds": [],
        "nextCursor": null,
        "exhausted": true
    }))
}

#[tauri::command]
pub fn library_cover_progress() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "totalDistinct": 0,
        "pending": 0,
        "done": 0
    }))
}

#[tauri::command]
pub fn cover_revalidate_enqueue() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn cover_revalidate_tick() -> Result<u32, String> {
    Ok(0)
}

#[tauri::command]
pub fn cover_revalidate_batch() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "cursor": null,
        "processed": 0,
        "changed": 0
    }))
}
