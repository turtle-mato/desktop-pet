//! Lightweight context only: input inactivity, foreground app, known game windows,
//! Windows media-session playback metadata. Never capture hidden-window pixels.
use serde::Serialize;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindow { pub window_id: String, pub title: String, pub process: String, pub minimized: bool, pub kind: String }
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession { pub title: String, pub source: String, pub playing: bool, pub kind: String }
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub observed_at: u64, pub idle_seconds: Option<u64>, pub unavailable: bool, pub sensitive_foreground: bool,
    pub foreground: AppWindow, pub background: Vec<AppWindow>, pub media: Vec<MediaSession>,
    pub media_available: bool,
}

fn sensitive(text: &str) -> bool {
    let t = text.to_lowercase();
    ["密码", "验证码", "银行", "支付", "登录", "密钥", "隐私", "无痕", "password", "private", "incognito", "secret", "token", "credential"]
        .iter().any(|s| t.contains(s))
}

fn app_kind(process: &str) -> &'static str {
    match process.to_ascii_lowercase().as_str() {
        "genshinimpact.exe" | "yuanshen.exe" | "starrail.exe" | "zenlesszonezero.exe" |
        "league of legends.exe" | "valorant-win64-shipping.exe" | "cs2.exe" | "dota2.exe" |
        "overwatch.exe" | "minecraft.windows.exe" | "terraria.exe" | "stardew valley.exe" |
        "eldenring.exe" | "wuthering waves.exe" | "client-win64-shipping.exe" => "game",
        "code.exe" | "devenv.exe" | "rider64.exe" | "idea64.exe" | "pycharm64.exe" |
        "webstorm64.exe" | "winword.exe" | "excel.exe" | "powerpnt.exe" | "wps.exe" |
        "et.exe" | "wpp.exe" | "photoshop.exe" | "illustrator.exe" | "blender.exe" |
        "notepad++.exe" | "windowsterminal.exe" | "codex.exe" => "work",
        "potplayermini64.exe" | "potplayermini.exe" | "vlc.exe" | "mpv.exe" | "mpc-hc64.exe" => "video",
        "explorer.exe" => "shell",
        _ => "unknown",
    }
}

#[cfg(windows)]
fn read_activity() -> ActivitySnapshot {
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_NAME_WIN32};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible};
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus};
    use windows::Media::MediaPlaybackType;

    unsafe fn info(hwnd: HWND) -> Option<AppWindow> {
        if hwnd.is_invalid() || !unsafe { IsWindowVisible(hwnd) }.as_bool() { return None; }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
        if pid == std::process::id() { return None; }
        let mut title = [0u16; 256];
        let n = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
        let title = String::from_utf16_lossy(&title[..n]);
        if title.is_empty() || sensitive(&title) { return None; }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut path = [0u16; 2048]; let mut len = path.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(path.as_mut_ptr()), &mut len) };
        let _ = unsafe { CloseHandle(process) };
        if ok.is_err() { return None; }
        let path = String::from_utf16_lossy(&path[..len as usize]);
        let name = path.rsplit('\\').next().unwrap_or("").to_ascii_lowercase();
        Some(AppWindow { window_id: format!("{}", hwnd.0 as usize), title,
            kind: app_kind(&name).into(), process: name, minimized: unsafe { IsIconic(hwnd) }.as_bool() })
    }
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
        let windows = unsafe { &mut *(data.0 as *mut Vec<AppWindow>) };
        if windows.len() < 12 {
            if let Some(item) = unsafe { info(hwnd) } { if item.kind == "game" || item.kind == "video" { windows.push(item); } }
        }
        windows::core::BOOL(1)
    }
    let mut result = ActivitySnapshot { observed_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_millis() as u64, ..Default::default() };
    unsafe {
        let hwnd = GetForegroundWindow();
        result.unavailable = hwnd.is_invalid();
        let mut title = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        result.sensitive_foreground = sensitive(&String::from_utf16_lossy(&title[..n]));
        if result.sensitive_foreground { return result; }
        result.foreground = info(hwnd).unwrap_or_else(|| AppWindow { window_id: format!("{}", hwnd.0 as usize), ..Default::default() });
        let mut last = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut last).as_bool() { result.idle_seconds = Some(GetTickCount().wrapping_sub(last.dwTime) as u64 / 1000); }
        let _ = EnumWindows(Some(collect), LPARAM((&mut result.background as *mut Vec<AppWindow>) as isize));
        result.background.retain(|w| w.window_id != result.foreground.window_id);
    }
    // No playback command is sent; metadata read-only. Unsupported apps simply
    // provide no session, not a fabricated "playing" status.
    if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
        if let Ok(sessions) = manager.GetSessions() {
            result.media_available = true;
            for i in 0..sessions.Size().unwrap_or(0).min(12) {
                let Ok(session) = sessions.GetAt(i) else { continue; };
                let playing = session.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).ok() == Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);
                if !playing { continue; }
                let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) else { continue; };
                let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
                let source = session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default();
                if title.is_empty() || sensitive(&title) || sensitive(&source) { continue; }
                let kind = match props.PlaybackType().and_then(|v| v.Value()).ok() {
                    Some(MediaPlaybackType::Video) => "video", Some(MediaPlaybackType::Music) => "music", _ => "unknown",
                };
                result.media.push(MediaSession { title: title.chars().take(160).collect(), source: source.chars().take(160).collect(), playing, kind: kind.into() });
                if result.media.len() >= 4 { break; }
            }
        }
    }
    result
}

#[tauri::command]
pub async fn screen_activity(window: tauri::Window) -> Result<ActivitySnapshot, String> {
    if window.label() != "main" { return Err("仅主窗口可读取活动状态".into()); }
    if !super::screen_awareness::is_enabled() { return Err("屏幕感知未开启".into()); }
    #[cfg(windows)]
    let result = tauri::async_runtime::spawn_blocking(read_activity).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let result = ActivitySnapshot::default();
    if !super::screen_awareness::is_enabled() { return Err("屏幕感知已关闭".into()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn conservative_app_types() {
        assert_eq!(app_kind("Code.exe"), "work"); assert_eq!(app_kind("GenshinImpact.exe"), "game");
        assert_eq!(app_kind("steam.exe"), "unknown"); assert_eq!(app_kind("chrome.exe"), "unknown");
        assert_eq!(app_kind("javaw.exe"), "unknown");
        assert!(sensitive("private browsing")); assert!(sensitive("银行支付"));
    }
    #[test] fn activity_smoke_metadata_only() {
        #[cfg(windows)] { let s = read_activity(); assert!(s.observed_at > 0); assert!(s.background.len() <= 12); assert!(s.media.len() <= 4);
            eprintln!("activity metadata: foreground_kind={}, background_count={}, playing_count={}, idle_available={}", s.foreground.kind, s.background.len(), s.media.len(), s.idle_seconds.is_some()); }
    }
}
