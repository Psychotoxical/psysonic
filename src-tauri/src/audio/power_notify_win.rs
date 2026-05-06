//! Windows: `PowerRegisterSuspendResumeNotification` — resume from sleep without a default-device rename.

use std::ffi::c_void;

use tauri::AppHandle;
use windows::Win32::{
    Foundation::{ERROR_SUCCESS, HANDLE},
    System::Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS},
    UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMRESUMESTANDBY,
    },
};

use super::power_resume::{debounce_allow_resume_reopen, reopen_audio_after_system_resume};

unsafe extern "system" fn power_suspend_resume_callback(
    context: *const c_void,
    event_type: u32,
    _setting: *const c_void,
) -> u32 {
    if context.is_null() {
        return 0;
    }
    if !matches!(
        event_type,
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND | PBT_APMRESUMESTANDBY
    ) {
        return 0;
    }

    if !debounce_allow_resume_reopen() {
        return 0;
    }

    let app = unsafe { &*(context as *const AppHandle) }.clone();

    tauri::async_runtime::spawn(async move {
        reopen_audio_after_system_resume(&app).await;
    });

    0
}

pub fn register(app: AppHandle) {
    // Intentionally leaked for process lifetime: Win32 callback receives this pointer
    // on each suspend/resume notification and may outlive this function scope.
    let app_leak = Box::into_raw(Box::new(app));

    let params = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(power_suspend_resume_callback),
        Context: app_leak as *mut c_void,
    });
    // Intentionally leaked for process lifetime: the power subsystem keeps the
    // subscribe-parameters pointer after successful registration.
    let params_ptr = Box::into_raw(params);

    let mut registration: *mut c_void = std::ptr::null_mut();
    let err = unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(params_ptr as *mut _),
            &mut registration as *mut *mut c_void,
        )
    };

    if err != ERROR_SUCCESS {
        crate::app_eprintln!(
            "[psysonic] PowerRegisterSuspendResumeNotification failed: {:?} — post-sleep audio recovery disabled",
            err
        );
        unsafe {
            drop(Box::from_raw(params_ptr));
            drop(Box::from_raw(app_leak));
        }
        return;
    }

    crate::app_eprintln!("[psysonic] Windows power suspend/resume notifications registered for audio");
    // `registration` is an opaque handle returned by Win32 API. It does not own
    // Rust resources, so dropping the local copy is fine; callback context is
    // intentionally leaked above for process-lifetime notifications.
}
