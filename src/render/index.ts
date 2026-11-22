// 外观适配器选择器：有 Live2D 模型就用 Live2D，否则回退静态图片
import { getSection } from "../core/config";
import { assetUrl } from "../core/env";
import type { EventBus } from "../core/bus";
import type { PetRenderer } from "./types";
import { StaticImageRenderer } from "./staticImage";
import { Live2DRenderer, hasLive2DCore, modelExists } from "./live2d";
import { TIQUN_MODEL } from './framing';
import type { PetView } from './types';

/** 旧的默认模型路径：只作为"未设置过"的判断依据，避免覆盖用户自己放好的模型 */
const LEGACY_DEFAULT_MODEL = "/live2d/model3.json";

export const RENDER_DEFAULTS = {
  renderer: "auto", // auto | image | live2d
  live2dModel: TIQUN_MODEL,
};

export interface RendererHandle {
  renderer: PetRenderer;
  note: string;
}

export async function createPetRenderer(
  opts: {
    imgClass?: string;
    canvasClass?: string;
    wrapClass?: string;
    /** 外观配置（来自 AppearanceStore）。不传则回退读 cfg.appearance 段 */
    cfg?: { renderer?: string; live2dModel?: string; view?: PetView };
    /** true = 按立绘"实际画出来的像素"贴合（小窗用，判定框才会贴着立绘） */
    tightFit?: boolean;
  } = {},
): Promise<RendererHandle> {
  const cfg = opts.cfg ?? (getSection("appearance", RENDER_DEFAULTS as any) as any);
  const mode: string = cfg.renderer || RENDER_DEFAULTS.renderer;
  let path: string = cfg.live2dModel || RENDER_DEFAULTS.live2dModel;

  // 旧默认值残留：只有它真的不存在时才迁移到新默认，避免覆盖用户自己放的模型
  if (path === LEGACY_DEFAULT_MODEL && !(await modelExists(path))) {
    path = RENDER_DEFAULTS.live2dModel;
  }
  const modelUrl = assetUrl(path);
  let reason = mode === 'image' ? '外观设置为图片' : '';

  if (mode !== "image") {
    const core = await hasLive2DCore();
    if (core) {
      const exists = await modelExists(path);
      if (exists) {
        try {
          const r = new Live2DRenderer(modelUrl, {
            canvasClass: opts.canvasClass,
            wrapClass: opts.wrapClass,
            tightFit: opts.tightFit,
            view: cfg.view,
          });
          await r.load();
          return { renderer: r, note: `Live2D（${path}）` };
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
          console.warn("[render] Live2D 加载失败，已回退图片模式：", e);
        }
      } else if (mode === "live2d") {
        reason = `模型不存在：${path}`;
        console.warn("[render] 未找到 Live2D 模型文件：", path);
      }
    } else if (mode === "live2d") {
      reason = 'Cubism Core 未就绪';
      console.warn("[render] 未找到 Cubism Core（live2d/core/live2dcubismcore.min.js）");
    }
  }

  return { renderer: new StaticImageRenderer(opts.imgClass || "pet-img"), note: `图片模式：${reason || '模型或 Core 不可用'}` };
}

/** 把"说话"和聊天事件接起来：角色说话时张嘴，其它状态给个动作 */
export function bindRendererToChat(renderer: PetRenderer, bus: EventBus): void {
  let offTimer: ReturnType<typeof setTimeout> | undefined;
  bus.on("chat:pet", (e: any) => {
    if (e?.restore || e?.kind === 'sys') return;
    renderer.speak(true);
    clearTimeout(offTimer);
    offTimer = setTimeout(() => renderer.speak(false), 1200);
  });
  bus.on("chat:user", () => renderer.play("idle"));
  bus.on("chat:thinking", ({ on }: any) => {
    if (on) renderer.play("idle");
  });
}
