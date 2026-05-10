//! Windows Taskbar Thumbnail Toolbar (ITaskbarList3::ThumbBarAddButtons).
//!
//! Adds Prev / Play-Pause / Next buttons to the taskbar thumbnail preview.
//! Button clicks are intercepted via SetWindowSubclass and routed to the same
//! `media:prev`, `media:play-pause`, `media:next` events as souvlaki / tray.

use std::sync::atomic::{AtomicIsize, Ordering};

use tauri::{AppHandle, Emitter};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::{
            Shell::{
                DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass,
                TaskbarList, THUMBBUTTON, THUMBBUTTONFLAGS, THUMBBUTTONMASK, THBN_CLICKED,
                THB_FLAGS, THB_ICON, THB_TOOLTIP,
            },
            WindowsAndMessaging::{
                CreateIconFromResourceEx, DestroyIcon, HICON, LR_DEFAULTCOLOR,
                WM_COMMAND, WM_NCDESTROY,
            },
        },
    },
};

// ── Embedded ICO assets ──────────────────────────────────────────────────────

static PREV_ICO:  &[u8] = include_bytes!("../icons/windows/prev.ico");
static PLAY_ICO:  &[u8] = include_bytes!("../icons/windows/play.ico");
static PAUSE_ICO: &[u8] = include_bytes!("../icons/windows/pause.ico");
static NEXT_ICO:  &[u8] = include_bytes!("../icons/windows/next.ico");

// Button IDs — arbitrary u32 values, must fit in WPARAM low-word.
const BTN_PREV: u32 = 0xE001;
const BTN_PLAY: u32 = 0xE002;
const BTN_NEXT: u32 = 0xE003;

// Unique subclass ID.
const SUBCLASS_ID: usize = 0xC0DE_7A8B;

// Raw pointers kept as atomics so `update_taskbar_icon` can reach the
// COM object and icons without managed state.
static TASKBAR_PTR: AtomicIsize = AtomicIsize::new(0);
static HWND_VAL:    AtomicIsize = AtomicIsize::new(0);

// All four HICONs stored for WM_NCDESTROY cleanup and play/pause swapping.
static HICON_PREV:  AtomicIsize = AtomicIsize::new(0);
static HICON_PLAY:  AtomicIsize = AtomicIsize::new(0);
static HICON_PAUSE: AtomicIsize = AtomicIsize::new(0);
static HICON_NEXT:  AtomicIsize = AtomicIsize::new(0);

// ── ICO resource loader ──────────────────────────────────────────────────────

/// Load the best-match image from a raw `.ico` file in memory and return an HICON.
///
/// Parses the ICO directory to pick the entry with the highest bit depth
/// (32 bpp = true-colour + alpha), then passes the image bits directly to
/// `CreateIconFromResourceEx`.
///
/// Note: `LookupIconIdFromDirectoryEx` operates on Win32 *resource* group-icon
/// format (GRPICONDIR), not raw `.ico` files, so we parse the ICO header ourselves.
unsafe fn load_icon_from_memory(bytes: &[u8]) -> HICON {
    // ICO file layout:
    //   ICONDIR        : reserved(2) + type(2) + count(2)
    //   ICONDIRENTRY[] : width(1) height(1) color_count(1) reserved(1)
    //                    planes(2) bit_count(2) bytes_in_res(4) image_offset(4)
    if bytes.len() < 6 {
        return HICON::default();
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if count == 0 || bytes.len() < 6 + count * 16 {
        return HICON::default();
    }

    // Pick the entry with the highest bit depth; 32 bpp carries alpha.
    let mut best_idx = 0usize;
    let mut best_bpp = 0u16;
    for i in 0..count {
        let base = 6 + i * 16;
        let bpp = u16::from_le_bytes([bytes[base + 6], bytes[base + 7]]);
        if bpp >= best_bpp {
            best_bpp = bpp;
            best_idx = i;
        }
    }

    let entry      = &bytes[6 + best_idx * 16..];
    let img_size   = u32::from_le_bytes(entry[8..12].try_into().unwrap_or([0; 4]));
    let img_offset = u32::from_le_bytes(entry[12..16].try_into().unwrap_or([0; 4])) as usize;

    if img_size == 0 || img_offset + img_size as usize > bytes.len() {
        return HICON::default();
    }

    CreateIconFromResourceEx(
        &bytes[img_offset..img_offset + img_size as usize],
        true,        // fIcon = TRUE
        0x0003_0000, // dwVer = 3.0 (required by the API)
        0, 0,        // cxDesired / cyDesired — 0 lets the system choose
        LR_DEFAULTCOLOR,
    )
    .unwrap_or_default()
}

// ── Button descriptors ───────────────────────────────────────────────────────

fn copy_tip(dest: &mut [u16], src: &str) {
    let wide: Vec<u16> = src.encode_utf16().chain(std::iter::once(0)).collect();
    let len = wide.len().min(dest.len());
    dest[..len].copy_from_slice(&wide[..len]);
}

unsafe fn make_buttons(
    h_prev: HICON,
    h_play: HICON,
    h_next: HICON,
) -> [THUMBBUTTON; 3] {
    let mask  = THUMBBUTTONMASK(THB_ICON.0 | THB_TOOLTIP.0 | THB_FLAGS.0);
    let flags = THUMBBUTTONFLAGS(0); // THBF_ENABLED

    let mut prev = THUMBBUTTON {
        dwMask: mask,
        iId: BTN_PREV,
        hIcon: h_prev,
        dwFlags: flags,
        ..Default::default()
    };
    copy_tip(&mut prev.szTip, "Previous");

    let mut play = THUMBBUTTON {
        dwMask: mask,
        iId: BTN_PLAY,
        hIcon: h_play,
        dwFlags: flags,
        ..Default::default()
    };
    copy_tip(&mut play.szTip, "Play");

    let mut next = THUMBBUTTON {
        dwMask: mask,
        iId: BTN_NEXT,
        hIcon: h_next,
        dwFlags: flags,
        ..Default::default()
    };
    copy_tip(&mut next.szTip, "Next");

    [prev, play, next]
}

// ── WndProc subclass ─────────────────────────────────────────────────────────

struct SubclassData {
    app: AppHandle,
}

unsafe extern "system" fn subclass_proc(
    hwnd:   HWND,
    msg:    u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uid:   usize,
    data:   usize,
) -> LRESULT {
    if msg == WM_COMMAND {
        let hi = (wparam.0 >> 16) as u32;
        let lo = (wparam.0 & 0xFFFF) as u32;
        if hi == THBN_CLICKED {
            if data != 0 {
                let state = &*(data as *const SubclassData);
                let _ = match lo {
                    x if x == BTN_PREV => state.app.emit("media:prev", ()),
                    x if x == BTN_PLAY => state.app.emit("media:play-pause", ()),
                    x if x == BTN_NEXT => state.app.emit("media:next", ()),
                    _ => Ok(()),
                };
            }
            return LRESULT(0);
        }
    }

    if msg == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        if data != 0 {
            drop(Box::from_raw(data as *mut SubclassData));
        }
        let raw = TASKBAR_PTR.swap(0, Ordering::SeqCst);
        if raw != 0 {
            drop(Box::from_raw(raw as *mut ITaskbarList3));
        }
        HWND_VAL.store(0, Ordering::SeqCst);
        // Destroy all stored HICONs.
        for cell in [&HICON_PREV, &HICON_PLAY, &HICON_PAUSE, &HICON_NEXT] {
            let h = cell.swap(0, Ordering::SeqCst);
            if h != 0 { let _ = DestroyIcon(HICON(h as *mut _)); }
        }
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

// ── Public init ──────────────────────────────────────────────────────────────

pub fn init(app: &AppHandle, hwnd_raw: isize) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let hwnd = HWND(hwnd_raw as *mut _);

        let taskbar: ITaskbarList3 = match CoCreateInstance(
            &TaskbarList, None, CLSCTX_INPROC_SERVER,
        ) {
            Ok(t)  => t,
            Err(e) => { crate::app_eprintln!("[psysonic] taskbar: CoCreateInstance failed: {e}"); return; }
        };

        if let Err(e) = taskbar.HrInit() {
            crate::app_eprintln!("[psysonic] taskbar: HrInit failed: {e}");
            return;
        }

        let h_prev  = load_icon_from_memory(PREV_ICO);
        let h_play  = load_icon_from_memory(PLAY_ICO);
        let h_pause = load_icon_from_memory(PAUSE_ICO);
        let h_next  = load_icon_from_memory(NEXT_ICO);

        // Store all HICONs for cleanup and play/pause swapping.
        HICON_PREV .store(h_prev .0 as isize, Ordering::SeqCst);
        HICON_PLAY .store(h_play .0 as isize, Ordering::SeqCst);
        HICON_PAUSE.store(h_pause.0 as isize, Ordering::SeqCst);
        HICON_NEXT .store(h_next .0 as isize, Ordering::SeqCst);

        let buttons = make_buttons(h_prev, h_play, h_next);
        if let Err(e) = taskbar.ThumbBarAddButtons(hwnd, &buttons) {
            crate::app_eprintln!("[psysonic] taskbar: ThumbBarAddButtons failed: {e}");
            return;
        }

        let raw = Box::into_raw(Box::new(taskbar));
        TASKBAR_PTR.store(raw as isize, Ordering::SeqCst);
        HWND_VAL   .store(hwnd_raw,     Ordering::SeqCst);

        let data = Box::into_raw(Box::new(SubclassData { app: app.clone() }));
        if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, data as usize).as_bool() {
            crate::app_eprintln!("[psysonic] taskbar: SetWindowSubclass failed");
            drop(Box::from_raw(data));
        }
    }
}

// ── Tauri command ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn update_taskbar_icon(is_playing: bool) {
    let taskbar_raw = TASKBAR_PTR.load(Ordering::SeqCst);
    let hwnd_raw    = HWND_VAL   .load(Ordering::SeqCst);
    if taskbar_raw == 0 || hwnd_raw == 0 { return; }

    let icon_raw = if is_playing {
        HICON_PAUSE.load(Ordering::SeqCst)
    } else {
        HICON_PLAY.load(Ordering::SeqCst)
    };
    if icon_raw == 0 { return; }

    unsafe {
        let taskbar = &*(taskbar_raw as *const ITaskbarList3);
        let hwnd    = HWND(hwnd_raw as *mut _);

        let mut btn = THUMBBUTTON {
            dwMask: THUMBBUTTONMASK(THB_ICON.0 | THB_TOOLTIP.0 | THB_FLAGS.0),
            iId: BTN_PLAY,
            hIcon: HICON(icon_raw as *mut _),
            dwFlags: THUMBBUTTONFLAGS(0),
            ..Default::default()
        };
        copy_tip(&mut btn.szTip, if is_playing { "Pause" } else { "Play" });

        let btns = [btn];
        if let Err(e) = taskbar.ThumbBarUpdateButtons(hwnd, &btns) {
            crate::app_deprintln!("[psysonic] taskbar: ThumbBarUpdateButtons failed: {e}");
            let _ = e;
        }
    }
}
