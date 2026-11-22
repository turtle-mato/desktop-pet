// 插件注册表：用 Vite 的 import.meta.glob 自动收集 plugins/*/index.ts
// 新增插件 = 新建一个文件夹放 index.ts + manifest.json，即可被自动加载
import type { PetPlugin } from "../core/pluginManager";

const modules = import.meta.glob<{ default: PetPlugin }>("./*/index.ts", { eager: true });

export const plugins: PetPlugin[] = Object.values(modules).map((m) => m.default);
