fn main() {
    // Windows/MSVC test binaries only: bind to Common-Controls v6.
    //
    // The library test harness (`--lib` unittests) links the wry/tao windowing
    // runtime and statically imports `TaskDialogIndirect` from comctl32, which
    // exists only in Common-Controls v6 (WinSxS). The real app binary gets that
    // manifest from `tauri_build`, but the separate test executable does not, so
    // it aborts at startup with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139). Add the
    // dependency to test targets only — never the app binary (which already has a
    // manifest via tauri_build) nor non-Windows/CI builds.
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        println!(
            "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
