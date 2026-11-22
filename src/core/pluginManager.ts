// 插件协议（docs/教程/第06课）与插件管理器
import type { EventBus } from "./bus";
import type { KV } from "./storage";
import type { AnyDict } from "./config";
import type { Session } from "./session";

export interface ChatApi {
  /** 让角色说话（气泡 + 进入对话历史）。kind: pet=日常/主动, sys=系统 */
  sayPet(text: string, kind?: "pet" | "initiative" | "sys" | "reminder"): void;
  /** 是否配置了大模型 API */
  readonly isAi: boolean;
  readonly isThinking?: boolean;
  /** 注册一段"状态背景"文本，注入 AI 的人设上下文 */
  addContext(fn: () => string): void;
  /** 主动发起一句话（AI 生成或本地模板） */
  generate(type: string, opts?: AnyDict): Promise<string>;
}

export interface PluginContext {
  id: string;
  bus: EventBus;
  kv: KV; // 本插件专属命名空间存储
  config: AnyDict; // 已合并默认值的配置
  setConfig(patch: AnyDict): void;
  session: Session;
  chat: ChatApi;
  api: Record<string, any>; // 可访问其他插件的 publicApi
  log(msg: string): void;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  order?: number; // 越小越先初始化
  enabled?: boolean;
  config?: AnyDict; // 默认配置
  description?: string;
}

export interface PetPlugin {
  manifest: PluginManifest;
  init(ctx: PluginContext): void | Promise<void>;
  start?(): void;
  stop?(): void;
  publicApi?: any; // 暴露给 UI / 其他插件
}

export class PluginManager {
  private plugins = new Map<string, PetPlugin>();
  api: Record<string, any> = {};

  constructor(private makeCtx: (id: string) => PluginContext) {}

  register(p: PetPlugin): void {
    if (p.manifest.enabled === false) return;
    if (this.plugins.has(p.manifest.id)) {
      console.warn(`[plugin] duplicate id "${p.manifest.id}" ignored`);
      return;
    }
    this.plugins.set(p.manifest.id, p);
  }

  defaultConfig(id: string): AnyDict | undefined {
    return this.plugins.get(id)?.manifest.config;
  }

  async initAll(): Promise<void> {
    const arr = [...this.plugins.values()].sort(
      (a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100) || a.manifest.id.localeCompare(b.manifest.id),
    );
    for (const p of arr) {
      const ctx = this.makeCtx(p.manifest.id);
      if (p.publicApi) this.api[p.manifest.id] = p.publicApi;
      try {
        await p.init(ctx);
      } catch (e) {
        console.error(`[plugin] init "${p.manifest.id}" failed`, e);
      }
    }
  }

  startAll(): void {
    for (const p of this.plugins.values()) {
      try {
        p.start?.();
      } catch (e) {
        console.error(`[plugin] start "${p.manifest.id}" failed`, e);
      }
    }
  }

  /** 只启动指定插件（小窗需要单独拉起 proactive，见 main.ts） */
  startOnly(ids: string[]): void {
    for (const id of ids) {
      const p = this.plugins.get(id);
      if (!p) continue;
      try {
        p.start?.();
      } catch (e) {
        console.error(`[plugin] start "${id}" failed`, e);
      }
    }
  }

  stopAll(): void {
    for (const p of [...this.plugins.values()].reverse()) {
      try {
        p.stop?.();
      } catch {}
    }
  }
}
