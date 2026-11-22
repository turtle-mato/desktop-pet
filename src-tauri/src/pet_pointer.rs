//! Cursor position only, without screenshots or input recording.
//! Extra canvas margins pass through to the desktop; original UI rectangles stay interactive.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Deserialize)]
pub struct HitRect { x: f64, y: f64, width: f64, height: f64 }
impl HitRect {
    fn valid(&self) -> bool {
        [self.x,self.y,self.width,self.height].iter().all(|v| v.is_finite())
            && self.width >= 0.0 && self.height >= 0.0
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x <= self.x+self.width && y <= self.y+self.height
    }
}
#[derive(Default, Clone)]
pub struct PointerState(Arc<Mutex<Option<Vec<HitRect>>>>);

#[tauri::command]
pub fn mini_set_hit_regions(window: tauri::Window, state: tauri::State<'_, PointerState>, regions: Vec<HitRect>) -> Result<(), String> {
    if window.label() != "mini" { return Err("Only mini can set its hit regions".into()); }
    if regions.len()>32 || regions.iter().any(|r| !r.valid()) { return Err("Invalid hit regions".into()); }
    *state.0.lock().map_err(|e| e.to_string())? = Some(regions);
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor { x: f64, y: f64, left_down: bool }

#[cfg(windows)]
pub fn start(app: &tauri::AppHandle) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    let app = app.clone();
    let state = app.state::<PointerState>().inner().clone();
    std::thread::spawn(move || {
        let mut ignored = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(32));
            let mut screen = POINT::default();
            if unsafe { GetCursorPos(&mut screen) }.is_err() { continue; }
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            for label in ["main", "mini"] {
                let Some(win) = app.get_webview_window(label) else { continue; };
                if !win.is_visible().unwrap_or(false) { continue; }
                let Ok(hwnd) = win.hwnd() else { continue; };
                let mut local = screen;
                if !unsafe { ScreenToClient(hwnd, &mut local) }.as_bool() { continue; }
                let scale = win.scale_factor().unwrap_or(1.0).max(0.1);
                let x = local.x as f64 / scale;
                let y = local.y as f64 / scale;
                let _ = win.emit("pet:cursor", Cursor { x, y, left_down: down });
                if label != "mini" { continue; }
                let regions = state.0.lock().ok().and_then(|s| s.clone());
                let Some(regions) = regions else { continue; };
                // Hold the initial routing during a press, including native dragging.
                let next = if down { ignored } else { !regions.iter().any(|r| r.contains(x,y)) };
                if next != ignored {
                    if win.set_ignore_cursor_events(next).is_ok() { ignored = next; }
                }
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn margins_do_not_expand_original_hit_region() {
        let r = HitRect{x:56.0,y:48.0,width:240.0,height:288.0};
        assert!(r.contains(56.0,48.0)); assert!(r.contains(295.0,335.0));
        assert!(!r.contains(55.0,100.0)); assert!(!r.contains(320.0,100.0));
        assert!(!r.contains(100.0,30.0)); assert!(!r.contains(100.0,350.0));
    }
    #[test]
    fn reject_invalid_geometry() {
        assert!(!HitRect{x:f64::NAN,y:0.0,width:200.0,height:100.0}.valid());
        assert!(!HitRect{x:0.0,y:0.0,width:-1.0,height:100.0}.valid());
    }
    #[test]
    fn native_release_is_available_to_the_layout_guard() {
        let value = serde_json::to_value(Cursor { x: -12.0, y: 48.0, left_down: false }).unwrap();
        assert_eq!(value["leftDown"], false);
        assert_eq!(value["x"], -12.0);
    }
}
