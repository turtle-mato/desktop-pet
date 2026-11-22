//! 本地屏幕感知：只在用户开启后按需读取一帧，识别文字后立刻丢弃像素。
//! 不写文件、不连接 mind、也不提供 HTTP 路由。Windows OCR 不是图像语义模型。
use std::sync::atomic::{AtomicBool, Ordering};
static SCREEN_ENABLED: AtomicBool = AtomicBool::new(false);
pub(crate) fn is_enabled() -> bool { SCREEN_ENABLED.load(Ordering::SeqCst) }

#[tauri::command]
pub fn screen_set_enabled(window: tauri::Window, enabled: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可以设置屏幕感知".into()); }
    SCREEN_ENABLED.store(enabled, Ordering::SeqCst);
    Ok(())
}
#[cfg(windows)]
mod windows_impl {
    use serde::Serialize;
    use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt,
        ClientToScreen, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, GetWindowRect, IsIconic, IsWindowVisible, GetWindow,
        GetClassNameW, GetClientRect, GetDesktopWindow, GetShellWindow, GW_HWNDPREV,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    #[derive(Serialize)]
    pub struct TextLine {
        pub text: String,
        pub left: f64,
        pub top: f64,
        pub width: f64,
        pub height: f64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Observation {
        pub title: String,
        pub text: String,
        pub captured_at: u64,
        pub width: i32,
        pub height: i32,
        pub window_id: String,
        pub pause_reason: String,
        pub window_class: String,
        pub lines: Vec<TextLine>,
        pub masked_regions: usize,
    }

    struct Target { hwnd: HWND, title: String, class: String, rect: RECT, masks: Vec<RECT> }
    enum TargetState { Ready(Target), Paused(&'static str) }

    // Capture runs on a pooled worker thread. Force physical screen coordinates
    // locally so client rectangles and screen DC pixels use the same DPI scale.
    struct CaptureDpi(DPI_AWARENESS_CONTEXT);
    impl CaptureDpi {
        fn enter() -> Self {
            Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
        }
    }
    impl Drop for CaptureDpi {
        fn drop(&mut self) {
            if !self.0.0.is_null() { unsafe { SetThreadDpiAwarenessContext(self.0); } }
        }
    }

    fn shell_reason(class: &str) -> Option<&'static str> {
        match class {
            "Progman" | "WorkerW" | "SHELLDLL_DefView" | "SysListView32" => Some("desktop"),
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "#32768" => Some("shell"),
            _ => None,
        }
    }

    unsafe fn shell_process(pid: u32) -> bool {
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return false; };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let result = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()), &mut len) };
        let _ = unsafe { CloseHandle(process) };
        if result.is_err() { return false; }
        let path = String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase();
        matches!(path.rsplit('\\').next().unwrap_or(""), "startmenuexperiencehost.exe" |
            "searchhost.exe" | "searchapp.exe" | "shellexperiencehost.exe" | "textinputhost.exe")
    }

    unsafe fn window_class(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..len])
    }

    fn same_rect(a: &RECT, b: &RECT) -> bool {
        a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
    }

    fn intersect(a: &RECT, b: &RECT) -> Option<RECT> {
        let rect = RECT { left: a.left.max(b.left), top: a.top.max(b.top),
            right: a.right.min(b.right), bottom: a.bottom.min(b.bottom) };
        (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
    }

    // Screen DC pixels include floating windows. Blank their intersection rather than
    // allowing the pet's own chat (or another overlay) to become screen evidence.
    unsafe fn occlusions(hwnd: HWND, client: &RECT) -> Vec<RECT> {
        let mut masks = Vec::new();
        let mut above = unsafe { GetWindow(hwnd, GW_HWNDPREV) }.ok();
        for _ in 0..256 {
            let Some(current) = above else { break };
            if current.is_invalid() { break; }
            above = unsafe { GetWindow(current, GW_HWNDPREV) }.ok();
            if !unsafe { IsWindowVisible(current) }.as_bool() || unsafe { IsIconic(current) }.as_bool() { continue; }
            let class = unsafe { window_class(current) };
            if matches!(class.as_str(), "Progman" | "WorkerW" | "SHELLDLL_DefView") { continue; }
            let mut cloaked = 0u32;
            let _ = unsafe { DwmGetWindowAttribute(current, DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(), std::mem::size_of::<u32>() as u32) };
            if cloaked != 0 { continue; }
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(current, &mut rect) }.is_ok() {
                if let Some(overlap) = intersect(client, &rect) { masks.push(overlap); }
            }
        }
        masks
    }

    fn target() -> Result<TargetState, String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            // Native integration tests target their own non-activating fixture;
            // production always uses the real foreground window above.
            #[cfg(test)]
            let hwnd = std::env::var("PET_SCREEN_FIXTURE_HWND").ok()
                .and_then(|s| s.parse::<usize>().ok()).map(|value| HWND(value as *mut _)).unwrap_or(hwnd);
            if hwnd.is_invalid() || IsIconic(hwnd).as_bool() { return Ok(TargetState::Paused("unavailable")); }
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() { return Ok(TargetState::Paused("self")); }
            let class = window_class(hwnd);
            if let Some(reason) = shell_reason(&class) { return Ok(TargetState::Paused(reason)); }
            if hwnd == GetDesktopWindow() || hwnd == GetShellWindow() { return Ok(TargetState::Paused("desktop")); }
            if shell_process(pid) { return Ok(TargetState::Paused("shell")); }
            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; len.max(0) as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
            let mut origin = POINT { x: 0, y: 0 };
            ClientToScreen(hwnd, &mut origin).ok().map_err(|e| e.to_string())?;
            rect.left += origin.x; rect.right += origin.x;
            rect.top += origin.y; rect.bottom += origin.y;
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            rect.left = rect.left.max(x);
            rect.top = rect.top.max(y);
            rect.right = rect.right.min(x + GetSystemMetrics(SM_CXVIRTUALSCREEN));
            rect.bottom = rect.bottom.min(y + GetSystemMetrics(SM_CYVIRTUALSCREEN));
            if rect.right <= rect.left || rect.bottom <= rect.top { return Ok(TargetState::Paused("unavailable")); }
            let masks = occlusions(hwnd, &rect);
            let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
            if masks.iter().any(|m| i64::from(m.right - m.left) * i64::from(m.bottom - m.top) * 100 >= area * 80) {
                return Ok(TargetState::Paused("occluded"));
            }
            Ok(TargetState::Ready(Target { hwnd, title, class, rect, masks }))
        }
    }

    fn unchanged(t: &Target) -> bool {
        match target() {
            Ok(TargetState::Ready(next)) => next.hwnd == t.hwnd && next.title == t.title &&
                same_rect(&next.rect, &t.rect) && next.masks.len() == t.masks.len() &&
                next.masks.iter().zip(&t.masks).all(|(a, b)| same_rect(a, b)),
            _ => false,
        }
    }

    fn capture(t: &Target) -> Result<(Vec<u8>, i32, i32), String> {
        unsafe {
            if !unchanged(t) { return Err("前台窗口已变化".into()); }
            let (source_width, source_height) = (t.rect.right - t.rect.left, t.rect.bottom - t.rect.top);
            let (x, y) = (t.rect.left, t.rect.top);
            if source_width <= 0 || source_height <= 0 { return Err("无法读取桌面尺寸".into()); }
            // OCR 对长边超过限制的图像会拒绝；缩到 2000px 防止多屏内存/CPU 激增。
            let scale = (2000.0 / source_width.max(source_height) as f64).min(1.0);
            let (width, height) = ((source_width as f64 * scale).round() as i32,
                (source_height as f64 * scale).round() as i32);
            let screen = GetDC(None);
            if screen.is_invalid() { return Err("无法获取屏幕 DC".into()); }
            let mem = CreateCompatibleDC(Some(screen));
            if mem.is_invalid() {
                ReleaseDC(None, screen);
                return Err("无法创建截图 DC".into());
            }
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            if bitmap.is_invalid() {
                let _ = DeleteDC(mem); ReleaseDC(None, screen);
                return Err("无法创建截图位图".into());
            }
            let old = SelectObject(mem, HGDIOBJ(bitmap.0));
            if old.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem);
                ReleaseDC(None, screen);
                return Err("无法将位图选入截图 DC".into());
            }
            let result = (|| {
                if width == source_width && height == source_height {
                    BitBlt(mem, 0, 0, width, height, Some(screen), x, y, SRCCOPY | CAPTUREBLT)
                        .map_err(|e| format!("截屏失败：{e}"))?;
                } else {
                    SetStretchBltMode(mem, HALFTONE);
                    if !StretchBlt(mem, 0, 0, width, height, Some(screen), x, y,
                        source_width, source_height, SRCCOPY).as_bool() {
                        return Err("缩放截屏失败".into());
                    }
                }
                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width, biHeight: -height, biPlanes: 1,
                    biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
                };
                let mut pixels = vec![0u8; width as usize * height as usize * 4];
                // GetDIBits 要求位图未选入 DC；先恢复旧对象再读像素。
                SelectObject(mem, old);
                let lines = GetDIBits(screen, bitmap, 0, height as u32,
                    Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
                if lines != height { return Err("无法读取截图像素".into()); }
                mask_pixels(&mut pixels, width, height, &t.rect, &t.masks);
                Ok((pixels, width, height))
            })();
            let _ = SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            if !unchanged(t) { return Err("前台窗口已变化".into()); }
            result
        }
    }

    fn mask_pixels(pixels: &mut [u8], width: i32, height: i32, source: &RECT, masks: &[RECT]) {
        let sx = width as f64 / (source.right - source.left) as f64;
        let sy = height as f64 / (source.bottom - source.top) as f64;
        for mask in masks {
            // Expand one pixel to exclude the anti-aliased edge after downscaling.
            let left = (((mask.left - source.left) as f64 * sx).floor() as i32 - 1).clamp(0, width);
            let top = (((mask.top - source.top) as f64 * sy).floor() as i32 - 1).clamp(0, height);
            let right = (((mask.right - source.left) as f64 * sx).ceil() as i32 + 1).clamp(0, width);
            let bottom = (((mask.bottom - source.top) as f64 * sy).ceil() as i32 + 1).clamp(0, height);
            for y in top..bottom {
                let start = ((y * width + left) * 4) as usize;
                let end = ((y * width + right) * 4) as usize;
                pixels[start..end].fill(255);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn desktop_and_taskbar_are_not_document_windows() {
            assert_eq!(shell_reason("Progman"), Some("desktop"));
            assert_eq!(shell_reason("WorkerW"), Some("desktop"));
            assert_eq!(shell_reason("Shell_TrayWnd"), Some("shell"));
            assert_eq!(shell_reason("Shell_SecondaryTrayWnd"), Some("shell"));
            assert_eq!(shell_reason("CabinetWClass"), None, "文件夹仍可正常读取");
            assert_eq!(shell_reason("Chrome_WidgetWin_1"), None);
            assert_eq!(shell_reason("Windows.UI.Core.CoreWindow"), None, "不能将所有 UWP 应用都误判为开始菜单");
        }

        #[test]
        fn masks_floating_windows_on_negative_coordinate_monitor() {
            let source = RECT { left: -100, top: 20, right: -90, bottom: 30 };
            let floating = RECT { left: -97, top: 23, right: -95, bottom: 25 };
            let mut pixels = vec![32u8; 10 * 10 * 4];
            mask_pixels(&mut pixels, 10, 10, &source, &[floating]);
            assert_eq!(pixels[(3 * 10 + 3) * 4], 255);
            assert_eq!(pixels[(2 * 10 + 2) * 4], 255, "遮掉缩放边缘的抗锯齿像素");
            assert_eq!(pixels[0], 32, "窗口正文未被遮挡的部分保持不变");
            assert_eq!(pixels[(9 * 10 + 9) * 4], 32);
        }

        #[test]
        fn scales_and_clips_overlay_masks() {
            let source = RECT { left: 0, top: 0, right: 200, bottom: 100 };
            let floating = RECT { left: 150, top: -10, right: 300, bottom: 150 };
            let overlap = intersect(&source, &floating).unwrap();
            assert_eq!((overlap.left, overlap.top, overlap.right, overlap.bottom), (150, 0, 200, 100));
            let mut pixels = vec![32u8; 100 * 50 * 4];
            mask_pixels(&mut pixels, 100, 50, &source, &[overlap]);
            assert_eq!(pixels[(25 * 100 + 90) * 4], 255);
            assert_eq!(pixels[(25 * 100 + 50) * 4], 32);
            assert!(intersect(&source, &RECT { left: 200, top: 0, right: 220, bottom: 30 }).is_none());
        }

        #[test]
        fn reads_desktop_without_persisting_pixels() {
            let result = super::observe().expect("Windows screen capture + OCR should succeed");
            if result.pause_reason.is_empty() {
                assert!(result.width > 0 && result.height > 0);
            } else {
                assert!(result.text.is_empty() && result.lines.is_empty());
                assert_eq!((result.width, result.height), (0, 0));
            }
            assert!(result.captured_at > 0);
            let compact = result.text.to_uppercase().replace(char::is_whitespace, "");
            if let Ok(expected) = std::env::var("PET_SCREEN_EXPECT") {
                assert!(compact.contains(&expected.to_uppercase().replace(char::is_whitespace, "")),
                    "fixture body must be recognized; chars={}, masks={}", result.text.chars().count(), result.masked_regions);
            }
            if std::env::var("PET_SCREEN_EXPECT_EMPTY").is_ok() {
                assert!(result.text.trim().is_empty(), "blank client area must not acquire titlebar/desktop text");
            }
            if let Ok(forbidden) = std::env::var("PET_SCREEN_FORBIDDEN") {
                for marker in forbidden.split('|') {
                    assert!(!compact.contains(&marker.to_uppercase().replace(char::is_whitespace, "")),
                        "text outside the client area or underneath another window must not become evidence");
                }
            }
            // 不打印屏幕文字或标题，只验证它们的长度。
            eprintln!("screen smoke: {}x{}, title_chars={}, ocr_chars={}, positioned_lines={}, masks={}",
                result.width, result.height, result.title.chars().count(), result.text.chars().count(), result.lines.len(), result.masked_regions);
        }
    }

    /// GDI 输出是 BGRA，但 JPEG encode 只接受 RGB/Luma，不接受 Rgba8。
    fn encode_bgra_jpeg(pixels: &[u8], width: u32, height: u32, max_width: u32) -> Result<Vec<u8>, String> {
        let expected = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4));
        if width == 0 || height == 0 || expected != Some(pixels.len()) {
            return Err("截图像素尺寸无效".into());
        }
        let mut rgb = Vec::with_capacity(pixels.len() / 4 * 3);
        for px in pixels.chunks_exact(4) { rgb.extend_from_slice(&[px[2], px[1], px[0]]); }
        let img = image::RgbImage::from_raw(width, height, rgb).ok_or_else(|| "构造图像失败".to_string())?;
        let target_w = max_width.clamp(320, 1600);
        let img = if img.width() > target_w {
            let target_h = ((img.height() as f64) * (target_w as f64) / (img.width() as f64)).round().max(1.0) as u32;
            image::imageops::resize(&img, target_w, target_h, image::imageops::FilterType::Triangle)
        } else { img };
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 72)
            .encode(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("编码 JPEG 失败：{e}"))?;
        Ok(buf)
    }

    #[cfg(test)]
    mod jpeg_tests {
        use super::*;
        #[test]
        fn jpeg_api_rejects_the_old_rgba_format() {
            let mut buf = Vec::new();
            let result = image::codecs::jpeg::JpegEncoder::new(&mut buf)
                .encode(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8);
            assert!(result.is_err(), "原实现的 Rgba8 在此 JPEG API 中不可编码");
        }
        #[test]
        fn screenshot_bgra_becomes_valid_rgb_jpeg() {
            let pixels = [0u8, 0, 255, 0].repeat(16 * 16);
            let bytes = encode_bgra_jpeg(&pixels, 16, 16, 1280).unwrap();
            assert_eq!(&bytes[..2], &[0xff, 0xd8]);
            let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap().to_rgb8();
            assert_eq!(decoded.dimensions(), (16, 16));
            let red = decoded.get_pixel(8, 8);
            assert!(red[0] > 220 && red[1] < 30 && red[2] < 30, "BGRA 必须正确换成 RGB，忽略 GDI 无效 alpha");
        }
        #[test]
        fn screenshot_jpeg_resize_and_invalid_buffer() {
            let bytes = encode_bgra_jpeg(&[255u8; 4].repeat(640 * 320), 640, 320, 320).unwrap();
            let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (320, 160));
            assert!(encode_bgra_jpeg(&[], 1, 1, 1280).is_err());
            assert!(encode_bgra_jpeg(&[], 0, 0, 1280).is_err());
        }
    }

    /// 截一帧并编码成 base64 JPEG。给"看懂画面"用，像素不落盘。
    pub fn capture_jpeg_b64(max_width: u32, expected_window_id: String, expected_title: String) -> Result<String, String> {
        let _dpi = CaptureDpi::enter();
        use base64::Engine as _;
        let t = match target()? {
            TargetState::Ready(t) => t,
            TargetState::Paused(_) => return Err("当前没有可观察的外部窗口".into()),
        };
        if format!("{}", t.hwnd.0 as usize) != expected_window_id || t.title != expected_title {
            return Err("前台窗口已变化，跳过旧画面请求".into());
        }
        let (pixels, width, height) = capture(&t)?;
        let buf = encode_bgra_jpeg(&pixels, width as u32, height as u32, max_width)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
    }

    pub fn observe() -> Result<Observation, String> {
        let _dpi = CaptureDpi::enter();
        let captured_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis() as u64;
        let t = match target()? {
            TargetState::Ready(t) => t,
            TargetState::Paused(reason) => return Ok(Observation { title: String::new(), text: String::new(), captured_at,
                width: 0, height: 0, window_id: String::new(), pause_reason: reason.into(),
                window_class: String::new(), lines: Vec::new(), masked_regions: 0 }),
        };
        let (pixels, width, height) = capture(&t)?;
        let writer = DataWriter::new().map_err(|e| e.to_string())?;
        writer.WriteBytes(&pixels).map_err(|e| e.to_string())?;
        // 像素仅用于本地 OCR，离开本函数即释放；从不传到前端/网络。
        let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width, height)
            .map_err(|e| format!("无法建立 OCR 位图：{e}"))?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|e| format!("Windows OCR 不可用：{e}"))?;
        let result = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?
            .get().map_err(|e| format!("OCR 识别失败：{e}"))?;
        let lines = result.Lines().map_err(|e| e.to_string())?;
        let mut texts = Vec::new();
        let mut positioned = Vec::new();
        for i in 0..lines.Size().map_err(|e| e.to_string())? {
            let line = lines.GetAt(i).map_err(|e| e.to_string())?;
            let text = line.Text().map_err(|e| e.to_string())?.to_string();
            texts.push(text.clone());
            // Keep OCR bounding boxes so front-end selection can distinguish page
            // content from navigation; cap payload, never persist the image or text.
            if positioned.len() < 180 {
                let words = line.Words().map_err(|e| e.to_string())?;
                let mut bounds: Option<(f64, f64, f64, f64)> = None;
                for j in 0..words.Size().map_err(|e| e.to_string())? {
                    let r = words.GetAt(j).map_err(|e| e.to_string())?.BoundingRect().map_err(|e| e.to_string())?;
                    let (l, t, r, b) = (r.X as f64, r.Y as f64, (r.X + r.Width) as f64, (r.Y + r.Height) as f64);
                    bounds = Some(match bounds { Some((x, y, right, bottom)) => (x.min(l), y.min(t), right.max(r), bottom.max(b)), None => (l, t, r, b) });
                }
                if let Some((left, top, right, bottom)) = bounds {
                    positioned.push(TextLine { text: text.chars().take(1000).collect(), left, top, width: right - left, height: bottom - top });
                }
            }
        }
        let text = texts.join("\n");
        if !unchanged(&t) { return Err("识别期间前台窗口已变化".into()); }
        // 只记长度，不记内容：用来判断"读不到字"是 OCR 空还是前端过滤掉了。
        let line_count = text.split('\n').count();
        let max_line = text.split('\n').map(|l| l.trim().chars().count()).max().unwrap_or(0);
        eprintln!(
            "[screen] title_chars={} ocr_chars={} lines={} max_line={}",
            t.title.chars().count(),
            text.chars().count(),
            line_count,
            max_line
        );
        Ok(Observation {
            title: t.title, text: text.chars().take(3000).collect(), width, height, captured_at,
            window_id: format!("{}", t.hwnd.0 as usize), pause_reason: String::new(),
            window_class: t.class, lines: positioned, masked_regions: t.masks.len(),
        })
    }
}

#[tauri::command]
pub async fn screen_observe(window: tauri::Window) -> Result<serde_json::Value, String> {
    // 只允许桌宠主窗口发起；浏览器里没有 IPC，也没有旁路的 HTTP 截屏端点。
    if window.label() != "main" { return Err("仅主窗口可以读取屏幕".into()); }
    if !SCREEN_ENABLED.load(Ordering::SeqCst) { return Err("屏幕感知未开启".into()); }
    #[cfg(windows)]
    {
        let observation = tauri::async_runtime::spawn_blocking(windows_impl::observe)
            .await.map_err(|e| e.to_string())??;
        // 关闭按钮可能在 OCR 正运行时按下；完成后再核对一次，避免泄出旧帧。
        if !SCREEN_ENABLED.load(Ordering::SeqCst) { return Err("屏幕感知已关闭".into()); }
        serde_json::to_value(observation).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    { Err("当前仅支持 Windows 桌面版".into()) }
}

/// 截一帧给"看图"用：返回 base64 JPEG，前端决定发给谁。
#[tauri::command]
pub async fn screen_capture_image(window: tauri::Window, max_width: Option<u32>, expected_window_id: String, expected_title: String) -> Result<String, String> {
    if window.label() != "main" { return Err("仅主窗口可以读取屏幕".into()); }
    if !SCREEN_ENABLED.load(Ordering::SeqCst) { return Err("屏幕感知未开启".into()); }
    #[cfg(windows)]
    {
        let w = max_width.unwrap_or(1024);
        let image = tauri::async_runtime::spawn_blocking(move || windows_impl::capture_jpeg_b64(w, expected_window_id, expected_title))
            .await.map_err(|e| e.to_string())??;
        if !SCREEN_ENABLED.load(Ordering::SeqCst) { return Err("屏幕感知已关闭".into()); }
        Ok(image)
    }
    #[cfg(not(windows))]
    { let _ = (max_width, expected_window_id, expected_title); Err("当前仅支持 Windows 桌面版".into()) }
}
