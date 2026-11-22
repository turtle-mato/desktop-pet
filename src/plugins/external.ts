// 外置插件加载器：从 app/plugins/ 目录动态加载（exe 外可编辑，无需重新打包）
// 约定：
//   app/plugins/plugins.json      → 字符串数组，列出要加载的插件文件夹名
//   app/plugins/<name>/plugin.js  → ESM，default 导出 (ctx) => PetPlugin | void
import type { PluginManager, PluginContext, PetPlugin } from "../core/pluginManager";
import { assetUrl } from "../core/env";

export interface ExternalDeps {
  mgr: PluginManager;
  makeCtx: (id: string) => PluginContext;
}

export async function loadExternalPlugins(deps: ExternalDeps): Promise<string[]> {
  const { mgr, makeCtx } = deps;
  const loaded: string[] = [];

  let ids: string[] = [];
  try {
    const r = await fetch(assetUrl("/plugins/plugins.json"), { cache: "no-store" });
    if (!r.ok) return loaded;
    const data = await r.json();
    if (Array.isArray(data)) ids = data.filter((x) => typeof x === "string");
  } catch {
    return loaded; // 没有外置插件目录：静默跳过
  }

  for (const id of ids) {
    try {
      const mod: any = await import(/* @vite-ignore */ assetUrl(`/plugins/${id}/plugin.js`));
      const def = mod?.default ?? mod;
      let plugin: PetPlugin | undefined;
      if (typeof def === "function") {
        plugin = (await def(makeCtx(id))) ?? undefined;
      } else if (def && def.manifest) {
        plugin = def as PetPlugin;
      }
      if (plugin && plugin.manifest) {
        mgr.register(plugin);
        loaded.push(id);
        console.log(`[external] 已加载外置插件：${id}`);
      } else {
        console.warn(`[external] 插件 ${id} 没有导出合法 manifest`);
      }
    } catch (e) {
      console.warn(`[external] 插件 ${id} 加载失败`, e);
    }
  }
  return loaded;
}
