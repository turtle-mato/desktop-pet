//! 系统托盘图标：直接调 Shell_NotifyIconW，自己建消息窗口。
//!
//! 不用 tauri 的 tray 封装——那套在 Win11 上 NIM_ADD 返回成功，
//! 但图标始终不出现在任务栏 / 溢出区里，查不出原因。这里什么都自己做：
//! 类、窗口、回调、注册、断言，每一步都能打印出来。

#[cfg(windows)]
pub fn install(app: tauri::AppHandle) {
    imp::install(app);
}

#[cfg(windows)]
pub fn probe(stage: &str) {
    unsafe { imp::probe(stage); }
}

#[cfg(not(windows))]
pub fn install(_app: tauri::AppHandle) {}

#[cfg(windows)]
mod imp {
    use std::mem::size_of;
    use std::sync::Mutex;
    use std::time::Duration;
    use windows::core::{w, GUID};
    use windows::Win32::Foundation::{GetLastError, SetLastError, WIN32_ERROR, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::Shell::{
        Shell_NotifyIconGetRect, Shell_NotifyIconW, NIF_GUID, NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP,
        NIF_TIP, NIM_ADD, NIM_DELETE, NIM_SETVERSION, NOTIFYICONDATAW, NOTIFYICONIDENTIFIER,
        NOTIFYICON_VERSION_4,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CopyIcon, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
        DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW, PostMessageW, RegisterClassW,
        RegisterWindowMessageW, SetForegroundWindow, TrackPopupMenu, TranslateMessage, HICON, IDI_APPLICATION,
        IMAGE_FLAGS, MF_SEPARATOR, MF_STRING, TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RETURNCMD,
        WINDOW_EX_STYLE, WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_LBUTTONUP, WM_NULL,
        WM_RBUTTONUP, WNDCLASSW, WS_OVERLAPPED,
    };

    const TRAY_ID: u32 = 1;
    const MENU_OPEN: usize = 1001;
    const MENU_TOGGLE: usize = 1002;
    const MENU_MINI: usize = 1003;
    const MENU_EXIT: usize = 1004;
    const WM_TRAY: u32 = WM_APP + 1;
    /// Post registration to the tray thread's message loop.
    /// A missing message loop has not been established as the cause of prior failures.
    const WM_TRAY_ADD: u32 = WM_APP + 2;
    const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
    const TRAY_GUID: GUID = GUID::from_u128(0x7d2b6a2f_6ce1_4a41_9c7d_5d9b7e3a21f0);

    static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
    static TASKBAR_CREATED: Mutex<u32> = Mutex::new(0);

    /// 从 ICO 里挑一张最接近 32×32 的图，做成 HICON。
    fn make_icon() -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
        if std::env::var("PET_TRAY_SYSICON").is_ok() {
            unsafe {
                // LoadIconW returns a shared handle; only destroy our private copy.
                return LoadIconW(None, IDI_APPLICATION).and_then(|h| CopyIcon(h)).ok();
            }
        }
        let bytes = ICON_BYTES;
        if bytes.len() < 6 || bytes[0] != 0 || bytes[1] != 0 || bytes[2] != 1 || bytes[3] != 0 {
            eprintln!("[tray] ico 头不对");
            return None;
        }
        let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        let mut best: Option<(i32, usize, usize)> = None; // (差, 偏移, 长度)
        for i in 0..count {
            let off = 6 + i * 16;
            if off + 16 > bytes.len() {
                break;
            }
            let w = if bytes[off] == 0 { 256 } else { bytes[off] as i32 };
            let len = u32::from_le_bytes([
                bytes[off + 8],
                bytes[off + 9],
                bytes[off + 10],
                bytes[off + 11],
            ]) as usize;
            let data_off = u32::from_le_bytes([
                bytes[off + 12],
                bytes[off + 13],
                bytes[off + 14],
                bytes[off + 15],
            ]) as usize;
            if data_off + len > bytes.len() {
                continue;
            }
            let diff = (w - 32).abs();
            if best.map(|b| diff < b.0).unwrap_or(true) {
                best = Some((diff, data_off, len));
            }
        }
        let (_, off, len) = best?;
        unsafe {
            match CreateIconFromResourceEx(
                &bytes[off..off + len],
                true,
                0x0003_0000,
                32,
                32,
                IMAGE_FLAGS(0),
            ) {
                Ok(h) => Some(h),
                Err(e) => {
                    eprintln!("[tray] CreateIconFromResourceEx 失败：{e:?}");
                    None
                }
            }
        }
    }

    unsafe fn add_icon(hwnd: HWND, hicon: HICON) -> bool {
        let mut nid = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: TRAY_ID,
            uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP | NIF_GUID,
            uCallbackMessage: WM_TRAY,
            hIcon: hicon,
            guidItem: TRAY_GUID,
            ..Default::default()
        };
        let tip: Vec<u16> = "陪伴桌宠".encode_utf16().chain(std::iter::once(0)).collect();
        for (i, c) in tip.iter().take(127).enumerate() { nid.szTip[i] = *c; }

        SetLastError(WIN32_ERROR(0));
        let added = Shell_NotifyIconW(NIM_ADD, &nid).as_bool();
        if !added {
            let err = windows::Win32::Foundation::GetLastError();
            eprintln!("[tray] NIM_ADD 失败 err={err:?} hicon={:?} hwnd={:?} guid={TRAY_GUID:?} flags={:?}", hicon.0, hwnd.0, nid.uFlags);
            let _ = DestroyIcon(hicon);
            return false;
        }
        nid.Anonymous.uVersion = NOTIFYICON_VERSION_4;
        let _ = Shell_NotifyIconW(NIM_SETVERSION, &nid);
        let ident = NOTIFYICONIDENTIFIER {
            cbSize: size_of::<NOTIFYICONIDENTIFIER>() as u32,
            hWnd: hwnd,
            uID: TRAY_ID,
            guidItem: TRAY_GUID,
            ..Default::default()
        };
        match Shell_NotifyIconGetRect(&ident) {
            Ok(r) => println!("[tray] 已注册 added=true 位置=({},{} {}x{})", r.left, r.top, r.right - r.left, r.bottom - r.top),
            Err(e) => eprintln!("[tray] 已注册但托盘里查不到位置：{e:?}"),
        }
        true
    }

    unsafe fn try_add_icon(hwnd: HWND, attempts: u32) {
        for attempt in 1..=attempts {
            if let Some(hicon) = make_icon() {
                if add_icon(hwnd, hicon) { return; }
            }
            if attempt < attempts { std::thread::sleep(Duration::from_millis(150)); }
        }
        eprintln!("[tray] 重试 {attempts} 次后仍未注册");
    }
    unsafe fn remove_icon(hwnd: HWND) {
        let nid = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: TRAY_ID,
            uFlags: NIF_GUID,
            guidItem: TRAY_GUID,
            ..Default::default()
        };
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }

    unsafe extern "system" fn probe_wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    // Same executable, but no Tauri state, custom icon, or persistent GUID.
    // Delete the transient probe icon immediately; never restart or modify Explorer.
    pub unsafe fn probe(stage: &str) {
        let result = (|| -> windows::core::Result<()> {
            let hinst = HINSTANCE(GetModuleHandleW(None)?.0);
            let cls = w!("DeskPetTrayDiagnosticWnd");
            let wc = WNDCLASSW { lpfnWndProc: Some(probe_wndproc), hInstance: hinst, lpszClassName: cls, ..Default::default() };
            let _ = RegisterClassW(&wc);
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), cls, w!("pet-tray-diagnostic"), WS_OVERLAPPED,
                0, 0, 0, 0, None, None, Some(hinst), None)?;
            let icon = match LoadIconW(None, IDI_APPLICATION) {
                Ok(icon) => icon,
                Err(e) => { let _ = DestroyWindow(hwnd); return Err(e); }
            };
            let nid = NOTIFYICONDATAW {
                cbSize: size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd, uID: 9001,
                uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
                uCallbackMessage: WM_TRAY,
                hIcon: icon,
                ..Default::default()
            };
            SetLastError(WIN32_ERROR(0));
            let added = Shell_NotifyIconW(NIM_ADD, &nid).as_bool();
            let error = GetLastError();
            eprintln!("[tray-probe] {stage} system-icon/no-guid added={added} err={error:?} hwnd={:?}", hwnd.0);
            if added { let _ = Shell_NotifyIconW(NIM_DELETE, &nid); }
            let _ = DestroyWindow(hwnd);
            Ok(())
        })();
        if let Err(e) = result { eprintln!("[tray-probe] {stage} setup-error={e:?}"); }
    }

    unsafe fn show_context_menu(hwnd: HWND) {
        let menu = match CreatePopupMenu() {
            Ok(menu) => menu,
            Err(e) => {
                eprintln!("[tray] CreatePopupMenu 失败：{e:?}");
                return;
            }
        };
        let _ = AppendMenuW(menu, MF_STRING, MENU_OPEN, w!("打开桌宠"));
        let _ = AppendMenuW(menu, MF_STRING, MENU_TOGGLE, w!("显示/隐藏窗口"));
        let _ = AppendMenuW(menu, MF_STRING, MENU_MINI, w!("切换到立绘小窗"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, w!(""));
        let _ = AppendMenuW(menu, MF_STRING, MENU_EXIT, w!("退出桌宠"));

        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_err() {
            let _ = DestroyMenu(menu);
            return;
        }
        // 先把消息窗口设为前台，确保菜单在选中或点击空白处后能正常收起。
        let _ = SetForegroundWindow(hwnd);
        let command = TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RETURNCMD,
            point.x,
            point.y,
            None,
            hwnd,
            None,
        )
        .0 as usize;
        let _ = DestroyMenu(menu);
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));

        let app = APP.lock().unwrap().clone();
        let Some(app) = app else {
            return;
        };
        match command {
            MENU_OPEN => crate::show_main(&app),
            MENU_TOGGLE => crate::toggle_visibility(&app),
            MENU_MINI => crate::show_mini(&app),
            MENU_EXIT => {
                remove_icon(hwnd);
                app.exit(0);
            }
            _ => {}
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let taskbar_created = *TASKBAR_CREATED.lock().unwrap();
        if taskbar_created != 0 && msg == taskbar_created {
            try_add_icon(hwnd, 6);
            return LRESULT(0);
        }
        match msg {
            WM_TRAY_ADD => { try_add_icon(hwnd, 10); LRESULT(0) }
            WM_TRAY => {
                let ev = (lp.0 & 0xFFFF) as u32;
                match ev {
                    WM_LBUTTONUP => {
                        if let Some(app) = APP.lock().unwrap().clone() { crate::show_main(&app); }
                    }
                    WM_RBUTTONUP | WM_CONTEXTMENU => show_context_menu(hwnd),
                    _ => {}
                }
                LRESULT(0)
            }
            WM_CONTEXTMENU => { show_context_menu(hwnd); LRESULT(0) }
            WM_DESTROY => { remove_icon(hwnd); LRESULT(0) }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
    unsafe fn tray_thread() {
        crate::diagnostics::log_context("tray-thread");
        let hinst = match GetModuleHandleW(None) {
            Ok(m) => HINSTANCE(m.0),
            Err(e) => { eprintln!("[tray] GetModuleHandle 失败：{e:?}"); return; }
        };
        *TASKBAR_CREATED.lock().unwrap() = RegisterWindowMessageW(w!("TaskbarCreated"));
        let cls = w!("DeskPetTrayWnd");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst, lpszClassName: cls, ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            eprintln!("[tray] RegisterClass 失败：{:?}", windows::Win32::Foundation::GetLastError());
        }
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0), cls, w!("deskpet-tray"), WS_OVERLAPPED,
            0, 0, 0, 0, None, None, Some(hinst), None,
        ) {
            Ok(h) => h,
            Err(e) => { eprintln!("[tray] CreateWindowEx 失败：{e:?}"); return; }
        };
        println!("[tray] 专用消息线程窗口已建 hwnd={:?}", hwnd.0);
        if let Err(e) = PostMessageW(Some(hwnd), WM_TRAY_ADD, WPARAM(0), LPARAM(0)) {
            eprintln!("[tray] PostMessage(WM_TRAY_ADD) 失败：{e:?}");
        }
        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        loop {
            let ret = GetMessageW(&mut msg, None, 0, 0).0;
            if ret <= 0 {
                if ret < 0 { eprintln!("[tray] GetMessage 失败"); }
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    pub fn install(app: tauri::AppHandle) {
        *APP.lock().unwrap() = Some(app);
        if let Err(e) = std::thread::Builder::new()
            .name("deskpet-tray".to_string())
            .spawn(|| unsafe { tray_thread() })
        {
            eprintln!("[tray] 创建专用消息线程失败：{e}");
        }
    }
}



