fn main() {
    // Windows/MSVC test binaries only: bind to Common-Controls v6.
    //
    // The `tauri` dev-dependency pulls the wry/tao windowing runtime into this
    // crate's *test* executables, which statically import `TaskDialogIndirect`
    // from comctl32. That symbol lives only in Common-Controls v6 (WinSxS); the
    // bare System32 comctl32.dll is v5.82 and does not export it, so an
    // unmanifested test exe aborts at startup with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xC0000139) before any test runs. The app binary avoids this through its
    // embedded manifest — mirror that here, scoped to test targets only (never
    // the app, the rlib, or non-Windows/CI builds).
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        println!(
            "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
