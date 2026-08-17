use tauri::{Emitter, Listener, Manager};

pub(crate) fn setup(app: &mut tauri::App) {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--theme-watch") {
        match args.get(i + 1).cloned() {
            Some(path) => {
                use std::collections::HashMap;
                use std::path::PathBuf;
                use std::sync::{Arc, Mutex};
                use std::time::SystemTime;

                // Accept a repo root (has themes/), a themes/ dir,
                // a single theme folder, or a bare theme.css.
                enum WatchTarget {
                    Dir(PathBuf),
                    File(PathBuf),
                }
                let root = PathBuf::from(&path);
                let target = if root.is_dir() && !root.join("theme.css").is_file() {
                    if root.join("themes").is_dir() {
                        WatchTarget::Dir(root.join("themes"))
                    } else {
                        WatchTarget::Dir(root)
                    }
                } else if root.is_dir() {
                    WatchTarget::File(root.join("theme.css"))
                } else {
                    WatchTarget::File(root)
                };
                match &target {
                    WatchTarget::Dir(d) => {
                        eprintln!("[theme-watch] watching {}/*/theme.css", d.display())
                    }
                    WatchTarget::File(f) => {
                        if !f.is_file() {
                            eprintln!(
                                "[theme-watch] warning: {} does not exist — nothing will load until it appears",
                                f.display()
                            );
                        }
                        eprintln!("[theme-watch] watching {}", f.display());
                    }
                }

                // Absolute, webview-loadable form of a watched path:
                // canonicalize resolves a relative `--theme-watch` argument,
                // and the `\\?\` prefix Windows canonicalization adds would
                // not survive `convertFileSrc` on the frontend.
                fn abs_watch_path(p: &std::path::Path) -> String {
                    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
                    let s = abs.to_string_lossy().into_owned();
                    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
                }

                // A watched theme's `url("assets/…")` resolves to an `asset:`
                // URL under its own directory, but the configured asset-protocol
                // scope only covers the app data dirs. Widen it for this
                // debug-only checkout path.
                {
                    let dir = match &target {
                        WatchTarget::Dir(d) => d.clone(),
                        WatchTarget::File(f) => f.parent().map(PathBuf::from).unwrap_or_default(),
                    };
                    let dir = PathBuf::from(abs_watch_path(&dir));
                    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
                        eprintln!(
                            "[theme-watch] could not grant asset access to {} — local theme assets will not load: {e}",
                            dir.display()
                        );
                    }
                }

                // Per-file state: css + manifest mtimes and the last payload.
                type Stamps = (Option<SystemTime>, Option<SystemTime>);
                type Seen = HashMap<PathBuf, (Stamps, serde_json::Value)>;
                let seen: Arc<Mutex<Seen>> = Arc::new(Mutex::new(HashMap::new()));

                // Re-send loaded themes after every frontend listener reload.
                let ready_event = if matches!(target, WatchTarget::Dir(_)) {
                    "theme-watch:css-seed"
                } else {
                    "theme-watch:css"
                };
                {
                    let seen = Arc::clone(&seen);
                    let handle = app.handle().clone();
                    app.listen("theme-watch:ready", move |_| {
                        let Ok(m) = seen.lock() else { return };
                        for (_, payload) in m.values() {
                            let _ = handle.emit(ready_event, payload);
                        }
                    });
                }

                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    let files: Vec<PathBuf> = match &target {
                        // Re-scan each tick so newly added theme folders appear.
                        WatchTarget::Dir(dir) => std::fs::read_dir(dir)
                            .map(|rd| {
                                rd.flatten()
                                    .map(|e| e.path().join("theme.css"))
                                    .filter(|p| p.is_file())
                                    .collect()
                            })
                            .unwrap_or_default(),
                        WatchTarget::File(f) => vec![f.clone()],
                    };
                    for f in files {
                        let css_mtime = std::fs::metadata(&f).and_then(|m| m.modified()).ok();
                        let manifest_path = f.parent().map(|d| d.join("manifest.json"));
                        let (manifest_exists, manifest_mtime) =
                            match manifest_path.as_ref().map(std::fs::metadata) {
                                Some(Ok(md)) => (true, md.modified().ok()),
                                _ => (false, None),
                            };
                        let stamps = (css_mtime, manifest_mtime);
                        let Ok(mut m) = seen.lock() else { continue };
                        if let Some(((prev_css, prev_manifest), _)) = m.get(&f) {
                            let css_fresh = prev_css.is_some() && *prev_css == css_mtime;
                            let manifest_fresh = *prev_manifest == manifest_mtime
                                && (manifest_mtime.is_some() || !manifest_exists);
                            if css_fresh && manifest_fresh {
                                continue;
                            }
                        }
                        let Ok(css) = std::fs::read_to_string(&f) else {
                            continue;
                        };
                        let manifest = manifest_path
                            .and_then(|p| std::fs::read_to_string(p).ok())
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                        let meta = |k: &str| {
                            manifest
                                .as_ref()
                                .and_then(|v| v.get(k))
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        };
                        let payload = serde_json::json!({
                            "css": css,
                            "name": meta("name"),
                            "author": meta("author"),
                            "version": meta("version"),
                            "description": meta("description"),
                            "mode": meta("mode"),
                            "assetBase": f.parent().map(abs_watch_path),
                        });
                        let event = match m.get_mut(&f) {
                            Some(entry) if entry.1 == payload => {
                                entry.0 = stamps;
                                continue;
                            }
                            Some(entry)
                                if entry.1.get("css").and_then(|c| c.as_str())
                                    == Some(css.as_str()) =>
                            {
                                "theme-watch:css-seed"
                            }
                            None if matches!(target, WatchTarget::Dir(_)) => "theme-watch:css-seed",
                            _ => "theme-watch:css",
                        };
                        if handle.emit(event, &payload).is_ok() {
                            m.insert(f, (stamps, payload));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(300));
                });
            }
            None => eprintln!(
                "[theme-watch] usage: --theme-watch <path/to/theme.css | path/to/themes-checkout>"
            ),
        }
    }
}
