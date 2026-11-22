// 运行环境信息：由启动器注入（外置资源基址 / 资源目录）
// 浏览器(dev)下 serverBase 为空字符串，所有路径按相对路径走（Vite 提供）
export const env = {
  serverBase: "",
  appDir: "",
};

/** 把 "/xxx" 这类外置资源路径转换为实际可访问 URL */
export function assetUrl(p: string): string {
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;
  return env.serverBase ? env.serverBase + p : p;
}

export async function primeEnv(): Promise<void> {
  try {
    if (!(window as any).__TAURI_INTERNALS__) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const e = await invoke<{ server_base?: string; app_dir?: string }>("pet_env");
    env.serverBase = (e?.server_base || "").replace(/\/$/, "");
    env.appDir = e?.app_dir || "";
  } catch (err) {
    console.warn("[env] 未能获取启动器环境信息，将使用相对路径", err);
  }
}
