use super::labels::thread_cpu_group_label;

#[test]
fn thread_cpu_group_label_tokio_and_named() {
    assert_eq!(thread_cpu_group_label("psy-tokio-3"), "tokio");
    assert_eq!(thread_cpu_group_label("tokio-runtime-w"), "tokio");
    assert_eq!(thread_cpu_group_label("tokio-rt-worker"), "tokio");
    assert_eq!(thread_cpu_group_label("psy-audio-out"), "psy-audio-out");
    assert_eq!(thread_cpu_group_label("psy-decode"), "psy-decode");
    assert_eq!(thread_cpu_group_label("psysonic-audio-"), "psysonic-audio-");
    assert_eq!(thread_cpu_group_label("pool-1"), "blocking-pool");
    assert_eq!(thread_cpu_group_label("gmain"), "glib");
    assert_eq!(thread_cpu_group_label("cpal_alsa_out"), "audio/pipewire");
    assert_eq!(thread_cpu_group_label("reqwest-interna"), "reqwest");
    assert_eq!(thread_cpu_group_label("rustc"), "other");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn child_process_memory_label_webkit_names() {
    use super::labels::child_process_memory_label;

    assert_eq!(child_process_memory_label("WebKitWebProces"), "WebKit web");
    assert_eq!(
        child_process_memory_label("WebKitNetworkP"),
        "WebKit network"
    );
    assert_eq!(
        child_process_memory_label("com.apple.WebKit.WebContent.xpc"),
        "WebKit web"
    );
    assert_eq!(
        child_process_memory_label("WebKit Networking"),
        "WebKit network"
    );
}
