// 陪伴桌宠 - 启动器（launcher）
// 职责：① 起一个本地静态服务，托管 exe 旁边 app/ 目录（界面/角色卡/模型/插件全部外置可编辑）
//       ② 代理 /dsai/* → DeepSeek（顺带解决 CORS，Key 只在本地）
//       ③ 建两个窗口（main 完整界面 / mini 立绘小窗）+ 系统托盘
mod screen_awareness;
mod screen_activity;
mod tray;
mod pet_pointer;
#[cfg(windows)]
mod diagnostics;

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn webview_data_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("webview-data")
}
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

static PINNED: AtomicBool = AtomicBool::new(false);

// ---------------- 资源目录：exe 同级的 app/ ----------------
fn app_root() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let app = dir.join("app");
    if app.join("index.html").exists() {
        app
    } else {
        dir
    }
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---------------- 本地静态服务 ----------------
// 固定端口：保证页面来源稳定（localStorage 里的设置/人格/记忆不会因端口变化而丢失）
// 同时也是"单实例"的判据：端口上已经有本桌宠 → 新进程直接退出并把已有窗口叫到前面。
const DEFAULT_PORT: u16 = 43110;
/// 单实例握手用的身份标记（确认端口上是本桌宠，而不是别的程序）
const SINGLETON_TAG: &str = "desktop-pet";

/// 本地服务端口（供前端查询外置资源/代理基址）
static SERVER_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

fn start_server(root: PathBuf, app: tauri::AppHandle) -> u16 {
    let preferred = ("127.0.0.1", DEFAULT_PORT);
    let listener = TcpListener::bind(preferred)
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .expect("无法绑定本地端口");
    let port = listener.local_addr().expect("local_addr").port();
    let _ = SERVER_PORT.set(port);
    std::thread::spawn(move || {
        let server = match tiny_http::Server::from_listener(listener, None) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[launcher] 本地服务启动失败: {e}");
                return;
            }
        };
        println!("[launcher] 资源目录: {}", root.display());
        println!("[launcher] 本地服务: http://127.0.0.1:{port}/");
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let is_options = request.method().as_str().eq_ignore_ascii_case("OPTIONS");
            if let Some(rest) = url.strip_prefix("/dsai") {
                if is_options {
                    // 跨域预检：页面(tauri.localhost) → 本地代理(127.0.0.1) 带 Authorization 时浏览器先问这一下
                    let _ = request.respond(with_cors(tiny_http::Response::empty(204)));
                } else {
                    proxy_deepseek(request, rest.to_string());
                }
            } else if url.starts_with("/__pet_ping") {
                // 单实例：新进程靠这个确认"43110 上那个确实是本桌宠"，不是别的程序
                let _ = request.respond(tiny_http::Response::from_string(SINGLETON_TAG));
            } else if url.starts_with("/__show") {
                // 单实例：新进程已经退出，这里把已有窗口叫到最前面
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let mini_visible = mini_window(&app2)
                        .map(|w| w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if mini_visible {
                        show_mini(&app2);
                    } else {
                        show_main(&app2);
                    }
                });
                let _ = request.respond(tiny_http::Response::from_string("ok"));
            } else {
                serve_static(request, &root, &url);
            }
        }
    });
    port
}

fn serve_static(request: tiny_http::Request, root: &Path, url_path: &str) {
    // 预检：页面来自本地来源(tauri.localhost)，跨域取外置资源需 CORS
    if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
        let _ = request.respond(with_cors(tiny_http::Response::empty(204)));
        return;
    }

    let clean = url_path.split('?').next().unwrap_or("/").to_string();
    let rel = clean.trim_start_matches('/');
    let mut target = if rel.is_empty() { root.join("index.html") } else { root.join(rel) };
    if target.is_dir() {
        target = target.join("index.html");
    }
    let inside = match (target.canonicalize(), root.canonicalize()) {
        (Ok(t), Ok(r)) => t.starts_with(&r),
        _ => false,
    };
    if !inside || !target.is_file() {
        // 单页应用：无扩展名的未知路径回退到 index.html
        let index = root.join("index.html");
        if !clean.contains('.') && index.is_file() {
            return respond_file(request, &index);
        }
        let _ = request.respond(with_cors(
            tiny_http::Response::from_string("404 Not Found").with_status_code(404),
        ));
        return;
    }
    respond_file(request, &target);
}

fn cors_headers() -> Vec<tiny_http::Header> {
    vec![
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], b"GET, POST, OPTIONS").unwrap(),
        tiny_http::Header::from_bytes(
            &b"Access-Control-Allow-Headers"[..],
            b"authorization, content-type, accept",
        )
        .unwrap(),
        tiny_http::Header::from_bytes(&b"Access-Control-Max-Age"[..], b"600").unwrap(),
        // 禁止 WebView2 缓存：本地文件读取没有成本，但一旦缓存住旧 index.html，
        // 改了界面重启还是老样子（真实踩过：功能介绍气泡删了还在显示）。
        tiny_http::Header::from_bytes(
            &b"Cache-Control"[..],
            b"no-store, no-cache, must-revalidate, max-age=0",
        )
        .unwrap(),
        tiny_http::Header::from_bytes(&b"Pragma"[..], b"no-cache").unwrap(),
        tiny_http::Header::from_bytes(&b"Expires"[..], b"0").unwrap(),
    ]
}

/// 给响应逐个挂上 CORS 头（tiny_http 只有单个 with_header）
fn with_cors<R: std::io::Read>(mut resp: tiny_http::Response<R>) -> tiny_http::Response<R> {
    for h in cors_headers() {
        resp = resp.with_header(h);
    }
    resp
}

fn respond_file(request: tiny_http::Request, path: &Path) {
    match fs::read(path) {
        Ok(data) => {
            let header =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], mime_of(path).as_bytes()).unwrap();
            let _ = request.respond(with_cors(
                tiny_http::Response::from_data(data).with_header(header),
            ));
        }
        Err(e) => {
            let _ = request.respond(with_cors(
                tiny_http::Response::from_string(format!("读取失败: {e}")).with_status_code(500),
            ));
        }
    }
}

// ---------------- /dsai 代理（解决 CORS，Key 不出本机） ----------------
fn proxy_deepseek(mut request: tiny_http::Request, path: String) {
    let url = format!("https://api.deepseek.com{}", path);
    let is_post = request.method().as_str().eq_ignore_ascii_case("POST");

    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let (mut auth, mut ctype, mut accept) = (String::new(), String::new(), String::new());
    for h in request.headers() {
        match h.field.as_str().as_str().to_ascii_lowercase().as_str() {
            "authorization" => auth = h.value.as_str().to_string(),
            "content-type" => ctype = h.value.as_str().to_string(),
            "accept" => accept = h.value.as_str().to_string(),
            _ => {}
        }
    }

    let mut call = if is_post { ureq::post(&url) } else { ureq::get(&url) };
    if !auth.is_empty() {
        call = call.set("Authorization", &auth);
    }
    if !ctype.is_empty() {
        call = call.set("Content-Type", &ctype);
    }
    if !accept.is_empty() {
        call = call.set("Accept", &accept);
    }

    let result = if is_post { call.send_bytes(&body) } else { call.call() };

    match result {
        Ok(resp) => {
            let status = resp.status();
            let reader = resp.into_reader();
            let response = tiny_http::Response::new(
                tiny_http::StatusCode(status),
                vec![tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    b"text/event-stream; charset=utf-8",
                )
                .unwrap()],
                reader,
                None, // 分块传输：SSE 流式逐块下发
                None,
            );
            let _ = request.respond(with_cors(response));
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            let _ = request.respond(with_cors(
                tiny_http::Response::from_string(text).with_status_code(code as u16),
            ));
        }
        Err(e) => {
            let _ = request.respond(with_cors(
                tiny_http::Response::from_string(format!("代理请求失败: {e}")).with_status_code(502),
            ));
        }
    }
}

// ---------------- 窗口与托盘 ----------------
fn main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}
fn mini_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("mini")
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(m) = mini_window(app) {
        let _ = m.hide();
    }
    // 托盘图标常驻：不再随窗口显示而摘掉（用户要它一直在溢出区里）
}

fn show_mini(app: &tauri::AppHandle) {
    if let Some(m) = mini_window(app) {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
    if let Some(w) = main_window(app) {
        let _ = w.hide();
    }
    // 托盘图标常驻，这里不再摘
}

/// 单实例：43110 上如果已经有本桌宠在跑，把它的窗口叫到最前面并返回 true。
/// 用"身份握手"确认对方是本桌宠（端口也可能被别的程序占着，那种情况就照旧换端口启动）。
fn bring_existing_to_front() -> bool {
    let base = format!("http://127.0.0.1:{DEFAULT_PORT}");
    let is_pet = ureq::get(&format!("{base}/__pet_ping"))
        .timeout(std::time::Duration::from_millis(800))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .map(|s| s.contains(SINGLETON_TAG))
        .unwrap_or(false);
    if !is_pet {
        return false;
    }
    let _ = ureq::get(&format!("{base}/__show"))
        .timeout(std::time::Duration::from_millis(1200))
        .call();
    true
}

fn toggle_visibility(app: &tauri::AppHandle) {
    let windows: Vec<tauri::WebviewWindow> = [main_window(app), mini_window(app)]
        .into_iter()
        .flatten()
        .collect();
    let visible_focused: Vec<bool> = windows
        .iter()
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .collect();
    if visible_focused.iter().any(|v| *v) {
        for (w, v) in windows.iter().zip(visible_focused.iter()) {
            if *v {
                let _ = w.hide();
            }
        }
        // 窗口全藏起来了；托盘图标一直在，不用再挂
    } else {
        show_main(app); // 内部会把托盘图标摘掉
    }
}

#[tauri::command]
fn win_show_main(app: tauri::AppHandle) -> Result<(), String> {
    show_main(&app);
    Ok(())
}

#[tauri::command]
fn win_show_mini(app: tauri::AppHandle) -> Result<(), String> {
    show_mini(&app);
    Ok(())
}

#[tauri::command]
fn win_hide(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    let _ = &app;
    Ok(())
}

#[tauri::command]
fn win_minimize(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    // 点"－" = 收起来。托盘图标启动时就已经挂在溢出区里，这里不用再挂。
    window.hide().map_err(|e| e.to_string())?;
    let _ = &app;
    Ok(())
}

#[tauri::command]
fn win_exit(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn win_toggle_pin(window: tauri::Window) -> Result<bool, String> {
    let next = !PINNED.swap(!PINNED.load(Ordering::Relaxed), Ordering::Relaxed);
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// 健康检查：前端用它确认 IPC（窗口按钮的后端通道）是否可用
#[tauri::command]
fn win_ping() -> String {
    "pong".to_string()
}

/// 前端启动时查询：外置资源/代理的基址、以及资源目录（用于插件加载）
#[tauri::command]
fn pet_env() -> serde_json::Value {
    let port = SERVER_PORT.get().copied().unwrap_or(DEFAULT_PORT);
    serde_json::json!({
        "server_base": format!("http://127.0.0.1:{port}"),
        "app_dir": app_root().to_string_lossy().to_string(),
    })
}

// ---------------- 开机自启动（写注册表，不额外引 crate） ----------------
/// Run 项里的值名（用 ASCII，免得编码问题）
const AUTOSTART_NAME: &str = "desktop-pet";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

// These small registry queries must never open a console or take keyboard focus.
fn autostart_registry(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = std::process::Command::new("reg");
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.output()
}

fn approval_disabled(output: &[u8]) -> bool {
    // reg's localized labels/paths are irrelevant: type and hex data are ASCII.
    String::from_utf8_lossy(output).lines().any(|line| {
        let columns: Vec<_> = line.split_whitespace().collect();
        columns.windows(2).any(|pair| pair[0] == "REG_BINARY"
            && matches!(pair[1].get(..2), Some("03" | "07")))
    })
}

#[cfg(test)]
mod autostart_tests {
    use super::approval_disabled;

    #[test]
    fn enabled_or_missing_approval_does_not_disable_startup() {
        assert!(!approval_disabled(b""));
        assert!(!approval_disabled(b"    desktop-pet    REG_BINARY    020000000000000000000000\r\n"));
        assert!(!approval_disabled(b"    desktop-pet    REG_BINARY    060000000000000000000000\r\n"));
    }

    #[test]
    fn disabled_approval_is_read_independently_of_localized_paths() {
        for state in ["03", "07"] {
            let output = format!("本地化路径\r\n    desktop-pet\tREG_BINARY\t{state}000000789C8F561D6FDD01\r\n");
            assert!(approval_disabled(output.as_bytes()));
        }
        assert!(!approval_disabled(b"    desktop-pet    REG_SZ    03000000\r\n"));
    }
}

fn autostart_windows_disabled() -> Result<bool, String> {
    let out = autostart_registry(&["query", APPROVED_RUN_KEY, "/v", AUTOSTART_NAME])
        .map_err(|e| e.to_string())?;
    // No approval record means Windows uses the registered Run command.
    Ok(out.status.success() && approval_disabled(&out.stdout))
}

/// 查当前是否已设为开机自启动；顺便把本 exe 路径回给前端显示
#[tauri::command]
fn autostart_get() -> serde_json::Value {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let out = autostart_registry(&["query", RUN_KEY, "/v", AUTOSTART_NAME]);
    let registered = matches!(&out, Ok(o) if o.status.success());
    let approval = autostart_windows_disabled();
    let windows_disabled = approval.as_ref().copied().unwrap_or(false);
    serde_json::json!({ "enabled": registered && approval.is_ok() && !windows_disabled,
        "registered": registered, "windowsDisabled": windows_disabled,
        "error": approval.err(), "exe": exe })
}

/// 开/关开机自启动（写的是当前用户，不需要管理员）
#[tauri::command]
fn autostart_set(enabled: bool) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    if enabled {
        // 路径带空格/中文，注册表里必须带引号
        let val = format!("\"{exe}\"");
        let out = autostart_registry(&[
                "add",
                RUN_KEY,
                "/v",
                AUTOSTART_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &val,
                "/f",
            ])
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        // Only an explicit enable action clears this app's prior disabled marker.
        // Never alter another startup app or enable it automatically during launch.
        if autostart_windows_disabled()? {
            let reset = autostart_registry(&["delete", APPROVED_RUN_KEY, "/v", AUTOSTART_NAME, "/f"])
                .map_err(|e| e.to_string())?;
            if !reset.status.success() || autostart_windows_disabled()? {
                return Err("启动路径已登记，但 Windows 仍禁用了桌宠启动项。".into());
            }
        }
        Ok(format!("已设为开机自启动：{exe}"))
    } else {
        // 值本来就不存在时 reg delete 会返回失败，这里当作"已经是关闭状态"处理
        let _ = autostart_registry(&["delete", RUN_KEY, "/v", AUTOSTART_NAME, "/f"]);
        Ok("已取消开机自启动".to_string())
    }
}

// ---------------- 自动拉起思维系统 ----------------
/// 找 mind 目录（放 server/server.ts 的那个）。桌宠和 mind 通常并排放在同一个工作区：
///   <工作区>/pet/release/陪伴桌宠.exe  →  <工作区>/mind/server/server.ts
fn find_mind_dir() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    // exe 旁的 app/mind-dir.txt 可以写一行自定义路径（放最前面，优先用）
    if let Ok(txt) = fs::read_to_string(exe_dir.join("app").join("mind-dir.txt")) {
        let p = txt.trim();
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    for up in ["../../", "../", ""] {
        candidates.push(exe_dir.join(format!("{up}mind")));
    }
    candidates.push(exe_dir.join("mind-server"));
    candidates
        .into_iter()
        .find(|d| d.join("server").join("server.ts").exists())
}

/// 检测不到思维系统时把它拉起来：返回 started:<pid> / already-running / 报错
#[cfg(windows)]
fn resolve_node_exe() -> PathBuf {
    let mut candidates = vec![
        PathBuf::from(r"D:\node.exe"),
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join("node.exe")));
    }
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("node.exe"))
}

#[cfg(windows)]
fn launch_mind_via_shell(mind: &Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let node = resolve_node_exe();
    let bat = std::env::temp_dir().join(format!("desktop-pet-mind-autostart-{}.bat", std::process::id()));
    let script = format!(
        "@echo off\r\nchcp 65001 >nul\r\ncd /d \"{}\" || exit /b 1\r\n\"{}\" \"server\\server.ts\" >> \"data\\auto-start.log\" 2>&1\r\n",
        mind.display(), node.display(),
    );
    eprintln!("[mind] 写入启动脚本：path={bat:?} node={node:?} cwd={mind:?}");
    std::fs::write(&bat, script).map_err(|e| format!("写入 mind 启动脚本失败：path={bat:?} error={e} os={:?}", e.raw_os_error()))?;

    let bat_w: Vec<u16> = bat.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dir_w: Vec<u16> = mind.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(None, w!("open"), PCWSTR(bat_w.as_ptr()), PCWSTR::null(), PCWSTR(dir_w.as_ptr()), SW_HIDE)
    };
    let code = result.0 as usize;
    if code <= 32 {
        return Err(format!("ShellExecuteW 启动 mind 失败，返回码={code}，脚本={:?}", bat));
    }
    eprintln!("[mind] 已交给 Windows Shell 启动：脚本={:?} node={:?} cwd={:?}", bat, node, mind);
    // Frontend tryStartMind expects the started:* protocol.
    Ok(format!("started:shell:{code}"))
}

#[cfg(not(windows))]
fn launch_mind_via_shell(mind: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new("node");
    cmd.arg(mind.join("server").join("server.ts")).current_dir(mind)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("启动 mind 失败：{e}"))?;
    Ok(format!("started:{}", child.id()))
}

/// 检测不到思维系统时把它拉起来：返回 started:* / already-running / 错误。
#[tauri::command]
fn ensure_mind(port: u16) -> Result<String, String> {
    #[cfg(windows)]
    diagnostics::log_context("ensure-mind");
    let url = format!("http://127.0.0.1:{port}/v1/health");
    if ureq::get(&url).timeout(std::time::Duration::from_millis(1200)).call().is_ok() {
        return Ok("already-running".to_string());
    }
    let mind_raw = find_mind_dir().ok_or_else(|| {
        "没找到 mind 目录（找过 exe 旁边的 ../../mind、./mind、/mind；也可以在 app/mind-dir.txt 里写一行自定义路径）".to_string()
    })?;
    let mind = std::fs::canonicalize(&mind_raw).unwrap_or(mind_raw);
    let mind = {
        let s = mind.to_string_lossy();
        match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => mind,
        }
    };
    eprintln!("[mind] 准备拉起，目录={:?}", mind);
    let launch = launch_mind_via_shell(&mind).map_err(|e| {
        eprintln!("[mind] 自动启动失败：{e}");
        e
    })?;
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if ureq::get(&url).timeout(std::time::Duration::from_millis(500)).call().is_ok() {
        eprintln!("[mind] Shell 启动后已监听：{url}");
    } else {
        eprintln!("[mind] Shell 已提交启动请求，暂未看到监听：{url}");
    }
    Ok(launch)
}
/// GUI 子系统程序没有控制台，双击启动时 stdout/stderr 是空句柄，
/// 任何 println!/eprintln! 都会 panic 让进程闪退。把两个句柄都指向
/// exe 同目录的 pet.log，调试输出照常保留（重定向启动时也能继续用）。
fn redirect_stdio_to_log() {
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let Ok(file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("pet.log"))
    else {
        return;
    };
    unsafe {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
        let h = HANDLE(file.as_raw_handle() as _);
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, h);
        let _ = SetStdHandle(STD_ERROR_HANDLE, h);
    }
    std::mem::forget(file); // 句柄必须活到进程结束
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    redirect_stdio_to_log();
    #[cfg(windows)]
    {
        diagnostics::startup();
        tray::probe("before-tauri");
    }
    tauri::Builder::default()
        .manage(pet_pointer::PointerState::default())
        .setup(|app| {
            // ⓪ 单实例：已经有她在跑 → 把已有窗口叫到最前，本次启动直接退出
            if bring_existing_to_front() {
                println!("[launcher] 已经有一个陪伴桌宠在运行，本次启动退出（已把她的窗口叫到前面）");
                std::process::exit(0);
            }

            // ① 本地服务（托管 app/ 目录 + DeepSeek 代理），端口供前端查询
            let _port = start_server(app_root(), app.handle().clone());

            // ② 运行时建窗口：界面来自内嵌资源（本地来源 → IPC 原生可用），
            //    而角色卡/立绘/Live2D/插件等"可编辑内容"从外部 app/ 目录经本地服务提供
            eprintln!("[launcher] 创建主窗口开始");
            let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("陪伴桌宠")
                .inner_size(700.0, 980.0)
                .min_inner_size(420.0, 600.0)
                .decorations(false)
                .transparent(true)
                .resizable(true)
                .center()
                .data_directory(webview_data_dir())
                // Windows: let HTML5 receive file drops for chat image uploads.
                .disable_drag_drop_handler()
                .build()
                .map_err(|e| format!("无法创建桌宠主窗口：{e}"))?;
            eprintln!("[launcher] 主窗口创建成功，开始创建小窗");

            let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html".into()))
                .title("陪伴桌宠")
                // 小窗是"贴着立绘"的：尺寸由前端的 fitWindow 按立绘实际大小算出来，
                // 这里只给个接近的初值，避免先闪一下大窗
                .inner_size(170.0, 290.0)
                .decorations(false)
                .transparent(true)
                .resizable(false)
                .visible(false)
                .skip_taskbar(true)
                .shadow(false)
                .data_directory(webview_data_dir())
                .disable_drag_drop_handler()
                .build()
                .map_err(|e| format!("无法创建桌宠小窗：{e}"))?;
            eprintln!("[launcher] 小窗创建成功");
            pet_pointer::start(app.handle());
            #[cfg(windows)]
            {
                diagnostics::log_context("after-webviews");
                tray::probe("after-webviews");
            }

            // ③ 托盘图标：自己调 Shell_NotifyIcon 注册（见 tray.rs）
            tray::install(app.handle().clone());
            Ok(())
        })
        // 点 X 就真的退出。
        // 以前这里会 prevent_close + hide（"拦下关闭、只把窗口藏起来"），
        // 结果是进程一直挂在后台、43110 被它占着；再双击 exe 时单实例判据
        // 认为"她已经在跑"就把新进程挡回去，看起来就像"打不开"。
        // 想让她常驻后台仍然可以用托盘菜单，所以这里不再拦截关闭，用默认行为。
        .invoke_handler(tauri::generate_handler![
            win_show_main,
            win_show_mini,
            win_hide,
            win_minimize,
            win_exit,
            win_toggle_pin,
            win_ping,
            pet_pointer::mini_set_hit_regions,
            pet_env,
            autostart_get,
            autostart_set,
            ensure_mind,
            screen_awareness::screen_observe,
            screen_awareness::screen_set_enabled,
            screen_activity::screen_activity,
            screen_awareness::screen_capture_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running desktop-pet");
}

