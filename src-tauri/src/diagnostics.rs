//! Read-only token diagnostics. Never impersonates, elevates, or changes ACLs.
use std::mem::size_of;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenIntegrityLevel, TokenIsAppContainer,
    TokenRestrictedSids, TokenSessionId, TokenUser, PSID, TOKEN_GROUPS,
    TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    OpenThreadToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

unsafe fn info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>, String> {
    let mut length = 0;
    let _ = GetTokenInformation(token, class, None, 0, &mut length);
    if length == 0 { return Err(format!("{:?}", windows::Win32::Foundation::GetLastError())); }
    // Token structures contain pointers, so a byte vector is not sufficiently aligned.
    let mut data = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    GetTokenInformation(token, class, Some(data.as_mut_ptr().cast()), length, &mut length)
        .map_err(|e| format!("{e:?}"))?;
    Ok(data)
}

unsafe fn sid_text(sid: PSID) -> String {
    let p = sid.0.cast::<u8>();
    if p.is_null() { return "null".into(); }
    let count = *p.add(1) as usize;
    if count > 15 { return "invalid-sid".into(); }
    let mut authority = 0u64;
    for i in 2..8 { authority = (authority << 8) | *p.add(i) as u64; }
    let mut text = format!("S-{}-{authority}", *p);
    for i in 0..count {
        text.push_str(&format!("-{}", std::ptr::read_unaligned(p.add(8 + i * 4).cast::<u32>())));
    }
    text
}

unsafe fn scalar(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> String {
    match info(token, class) {
        Ok(data) => format!("{}", *data.as_ptr().cast::<u32>()),
        Err(e) => format!("error:{e}"),
    }
}

unsafe fn log_token(stage: &str, kind: &str, token: HANDLE) {
    let user = info(token, TokenUser).map(|data| {
        sid_text((*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid)
    });
    let integrity = info(token, TokenIntegrityLevel).map(|data| {
        sid_text((*(data.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())).Label.Sid)
    });
    let restricted = info(token, TokenRestrictedSids).map(|data| {
        let groups = data.as_ptr().cast::<TOKEN_GROUPS>();
        let count = (*groups).GroupCount as usize;
        let ptr = std::ptr::addr_of!((*groups).Groups).cast::<windows::Win32::Security::SID_AND_ATTRIBUTES>();
        (0..count.min(32)).map(|i| sid_text((*ptr.add(i)).Sid)).collect::<Vec<_>>()
    });
    eprintln!("[diag] {stage} {kind}: user={user:?} integrity={integrity:?} restricted_sids={restricted:?} appcontainer={} elevated={} session={}",
        scalar(token, TokenIsAppContainer), scalar(token, TokenElevation), scalar(token, TokenSessionId));
}

pub fn log_context(stage: &str) {
    unsafe {
        eprintln!("[diag] {stage} pid={} tid={}", std::process::id(), GetCurrentThreadId());
        let mut token = HANDLE::default();
        match OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) {
            Ok(()) => { log_token(stage, "process", token); let _ = CloseHandle(token); }
            Err(e) => eprintln!("[diag] {stage} OpenProcessToken: {e:?}"),
        }
        match OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token) {
            Ok(()) => { log_token(stage, "thread-impersonation", token); let _ = CloseHandle(token); }
            Err(e) => eprintln!("[diag] {stage} thread-token={e:?} (ERROR_NO_TOKEN=1008 means no impersonation)"),
        }
    }
}

pub fn startup() {
    eprintln!("[diag] build=diag-20261102-1 epoch={:?} exe={:?} cwd={:?} temp={:?}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH),
        std::env::current_exe(), std::env::current_dir(), std::env::temp_dir());
    for key in ["TEMP", "TMP", "SystemRoot", "ComSpec", "USERPROFILE"] {
        eprintln!("[diag] env {key}={:?}", std::env::var_os(key));
    }
    eprintln!("[diag] NODE_OPTIONS_present={} NODE_PATH_present={}",
        std::env::var_os("NODE_OPTIONS").is_some(), std::env::var_os("NODE_PATH").is_some());
    log_context("before-tauri");
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return; };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut entries = Vec::new();
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            entries.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..end])));
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        let parent = entries.iter().find(|e| e.0 == std::process::id()).map(|e| e.1);
        for (pid, _, name) in entries {
            if Some(pid) != parent && !name.eq_ignore_ascii_case("explorer.exe") { continue; }
            eprintln!("[diag] reference pid={pid} name={name} parent={}", Some(pid) == parent);
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(process) => {
                    let mut token = HANDLE::default();
                    match OpenProcessToken(process, TOKEN_QUERY, &mut token) {
                        Ok(()) => { log_token("reference", &name, token); let _ = CloseHandle(token); }
                        Err(e) => eprintln!("[diag] reference OpenProcessToken: {e:?}"),
                    }
                    let _ = CloseHandle(process);
                }
                Err(e) => eprintln!("[diag] reference OpenProcess: {e:?}"),
            }
        }
    }
}
