// 插头 B：Live2D（读取 psd2live / Cubism 导出的 model3.json 文件族）
// 依赖：pixi.js + pixi-live2d-display（动态加载，不进主包）+ 官方 Cubism Core
import type { PetAnim, PetRenderer, PetTone, PetView } from "./types";
import { assetUrl } from "../core/env";
import { tiqunFrame, TIQUN_MODEL } from './framing';
import { TiqunAnimator } from './tiqun';

const CORE_PATH = "/live2d/core/live2dcubismcore.min.js";

/**
 * 桌宠动作语义 → 模型动作组的候选名（按优先级）。
 * psd2live 默认只导出 Idle/Blink/Nod/Shake，Cubism 手工做的模型可能是 Happy/Sad 等，
 * 所以这里按"取第一个模型实际拥有的"来解析，换模型不用改代码。
 */
const MOTION_PREFERENCE: Record<string, string[]> = {
  idle: ["Idle", "Idle1", "idle", "Motion"],
  blink: ["Blink", "blink", "Idle"],
  happy: ["Happy", "Smile", "Nod", "Idle"],
  sad: ["Sad", "Idle"],
  sleepy: ["Sleepy", "Idle"],
  angry: ["Angry", "Shake", "Idle"],
  tossed: ["Tossed", "Shake", "Nod", "Idle"],
};

/** 表情（Expressions）多是手工加的，没有就静默跳过 */
const EXPRESSIONS: Record<string, string> = {
  happy: "happy",
  sad: "sad",
  sleepy: "sleepy",
  angry: "angry",
};

/** 官方 Cubism Core 是否可用（需放入 app/live2d/core/live2dcubismcore.min.js） */
export async function hasLive2DCore(): Promise<boolean> {
  if ((window as any).Live2DCubismCore) return true;
  const coreSrc = assetUrl(CORE_PATH);
  try {
    // 用 GET 取回内容后"内联注入"，避免把 404 兜底页(HTML)当成 JS 加载导致
    // "Uncaught SyntaxError: Unexpected token '<'"
    const r = await fetch(coreSrc, { cache: "no-store" });
    if (!r.ok) return false;
    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    const text = await r.text();
    const looksJs = !text.trimStart().startsWith("<") && !ctype.includes("text/html");
    if (!looksJs) {
      console.warn(
        `[render] ${coreSrc} 不是有效的 JS（可能不存在、返回了 HTML 页面）。已跳过 Live2D，使用图片模式。`,
      );
      return false;
    }
    const s = document.createElement("script");
    s.textContent = text;
    document.head.appendChild(s);
  } catch {
    return false;
  }
  return !!(window as any).Live2DCubismCore;
}

/** 模型文件是否存在且是合法 JSON（避免把 HTML 兜底页当成模型） */
export async function modelExists(path: string): Promise<boolean> {
  try {
    const r = await fetch(assetUrl(path), { method: "GET", cache: "no-store" });
    if (!r.ok) return false;
    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    if (ctype.includes("text/html")) return false;
    const text = await r.text();
    if (text.trimStart().startsWith("<")) return false;
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export class Live2DRenderer implements PetRenderer {
  readonly kind = "live2d" as const;
  readonly element: HTMLElement;

  private canvas: HTMLCanvasElement;
  private app: any = null;
  private model: any = null;
  private ro: ResizeObserver | null = null;
  private speaking = false;
  private raf = 0;
  /** 模型实际拥有的动作组名（model3.json 的 Motions 键），加载后填充 */
  private motionGroups: string[] = [];
  /** 首次适配只打一次日志 */
  private fittedOnce = false;
  /** true = 按"实际画出来的像素"贴合（小窗用：立绘填满容器，判定框就贴着立绘） */
  private tightFit = false;
  private view: PetView = 'full';
  private animator: TiqunAnimator | null = null;
  private face = { x: 0, y: 0 };
  private captureBottomInset = 0;
  private frameCount = 0;
  private lastPose: Record<string, number> = {};

  diagnostics() {
    return { frames:this.frameCount, pose:this.lastPose, tickerStarted:this.app?.ticker?.started,
      canvas:[this.canvas.width,this.canvas.height], modelPath:this.modelPath };
  }

  constructor(
    private modelPath: string,
    opts: { canvasClass?: string; wrapClass?: string; tightFit?: boolean; view?: PetView } = {},
  ) {
    this.tightFit = !!opts.tightFit;
    this.canvas = document.createElement("canvas");
    if (opts.canvasClass) this.canvas.className = opts.canvasClass;
    const wrap = document.createElement("div");
    wrap.className = "pet-canvas-wrap" + (opts.wrapClass ? " " + opts.wrapClass : "");
    wrap.appendChild(this.canvas);
    this.element = wrap;
    this.view = opts.view === 'upper' ? 'upper' : 'full';
    wrap.dataset.view = this.view;
  }

  async load(): Promise<void> {
    if (!(await hasLive2DCore())) {
      throw new Error("缺少 Live2D Cubism Core：请把 live2dcubismcore.min.js 放到 public/live2d/core/");
    }
    const PIXI: any = await import("pixi.js");
    const live2d: any = await import("pixi-live2d-display/cubism4");
    const Live2DModel = live2d.Live2DModel;

    // pixi-live2d-display 需要宿主 Ticker 驱动
    try {
      Live2DModel.registerTicker?.(PIXI.Ticker);
    } catch {}

    const app = new PIXI.Application({
      view: this.canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoStart: true,
      resolution: window.devicePixelRatio || 1,
      // autoDensity 交给 pixi 会把 canvas 的显示尺寸设成"绘制缓冲尺寸"（=CSS尺寸×dpr），
      // 在高 DPI 机器上 canvas 就会撑出容器、角色被挤出可视区。这里自己管显示尺寸。
      autoDensity: false,
    });
    this.app = app;

    const model = await Live2DModel.from(this.modelPath, { autoInteract: false });
    this.model = model;
    app.stage.addChild(model);
    if (this.modelPath.endsWith(TIQUN_MODEL)) {
      this.animator = new TiqunAnimator();
      const internal = model.internalModel, core = internal.coreModel;
      internal.eyeBlink = undefined;
      internal.breath = undefined;
      internal.on('beforeModelUpdate', () => {
        const pose = this.animator!.frame(performance.now(), this.speaking);
        this.frameCount++;
        this.lastPose=pose;
        for (let i = 0; i < core.getParameterCount(); i++) core.setParameterValueByIndex(i, 0);
        for (const [id, value] of Object.entries(pose)) core.setParameterValueById(id, value);
      });
    }

    // 记下模型实际有的动作组，play() 时按名字挑最合适的，避免调用不存在的组
    try {
      const defs = model.internalModel?.motionManager?.definitions;
      this.motionGroups = defs ? Object.keys(defs) : [];
      console.log("[render] Live2D 动作组:", this.motionGroups.join(", ") || "（无）");
    } catch {
      this.motionGroups = [];
    }

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.element);
    // 保险：小窗的窗口尺寸是"按内容贴合"算出来的，可能在本帧之后才稳定，
    // 所以前几秒再补几次适配，避免按错误的尺寸定下缩放
    for (const ms of [250, 800, 2000]) {
      setTimeout(() => this.resize(), ms);
    }
    window.addEventListener("mousemove", this.onMouse);
    window.addEventListener('pet:cursor', this.onDesktopCursor);
    // 小窗的窗口尺寸是外壳按内容算出来的，窗口一变就重新贴合一次
    // （只靠 ResizeObserver 不够：canvas 尺寸被钉死时容器不变，就再也不会重算）
    window.addEventListener("resize", this.resize);
    void this.play("idle");
  }

  private resize = (): void => {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    // 还没布局好就别动：以前这里用 `|| 300 / || 450` 兜底，
    // 会把 canvas 撑成 300x450 的内联尺寸，反过来污染父容器量到的高度
    if (!this.app || !this.model || !w || !h) return;
    const pad = parseFloat(getComputedStyle(this.element).getPropertyValue('--pet-render-pad')) || 0;
    this.app.renderer.resize(w + pad*2, h + pad*2);
    // 显式把显示尺寸钉成我们做适配时用的那个 CSS 尺寸（绘制缓冲另算，保持高 DPI 清晰）
    this.canvas.style.width = w + pad*2 + "px";
    this.canvas.style.height = h + pad*2 + "px";
    if (this.animator) {
      const frame = tiqunFrame(this.view, w, h, this.model.internalModel.width, this.model.internalModel.height);
      this.model.anchor?.set?.(0, 0);
      this.model.scale.set(frame.scale);
      this.model.position.set(frame.x + pad, frame.y + pad);
      this.face = { x: frame.faceX, y: frame.faceY };
      // 半身固定收在腰部。扩展底部画布不会把腿重新露出来。
      // 此插件直接绘制 WebGL，普通 Pixi 遮罩无法可靠裁切；用画布可视范围固定下边界。
      this.captureBottomInset = this.view === 'upper' ? Math.max(0,h+pad-frame.bottom) : 0;
      this.canvas.style.clipPath = this.view === 'upper'
        ? `inset(0 0 ${this.captureBottomInset}px 0)` : 'none';
    } else {
      const ok = this.fitByBounds(w, h);
      if (ok && this.view === 'upper') {
        const b = this.model.getBounds();
        const zoom = 1.55;
        this.model.scale.set(this.model.scale.x * zoom);
        this.model.position.set(w / 2 - (w / 2 - this.model.position.x) * zoom, - (b.y - this.model.position.y) * zoom + 8);
      } else if (ok && this.tightFit) this.fitTight(w, h);
    }
  };

  setView(view: PetView): void {
    this.view = view === 'upper' ? 'upper' : 'full';
    this.element.dataset.view = this.view;
    this.resize();
    requestAnimationFrame(() => window.dispatchEvent(new Event('pet:renderer-ready')));
  }

  avatarState(): Record<string, unknown> {
    return { at: Date.now(), available: !!this.animator && !!this.model, view: this.view,
      speaking: this.speaking, ...this.animator?.state() };
  }

  avatarAct(action: import('../../../mind/server/lib/avatarProtocol').AvatarAction): boolean {
    return this.animator?.control(action) ?? false;
  }

  captureAvatar(): string | null {
    const gl = this.app?.renderer?.gl;
    if (!gl || !this.animator) return null;
    try {
      // Read the actual screen framebuffer: Live2D bypasses Pixi's texture extraction.
      this.app.renderer.render(this.app.stage);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const pixels = new Uint8Array(w*h*4);
      gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      if (gl.getError() !== gl.NO_ERROR) return null;
      const visibleH = Math.max(1, Math.min(h, h-Math.round(this.captureBottomInset*h/this.canvas.clientHeight)));
      const rgba = new Uint8ClampedArray(w*visibleH*4);
      let drawn = 0;
      for (let y=0; y<visibleH; y++) {
        const row = pixels.subarray((h-1-y)*w*4,(h-y)*w*4);
        rgba.set(row,y*w*4);
        for (let x=3; x<row.length; x+=4) if (row[x]>40) drawn++;
      }
      if (drawn < 100) return null;
      const raw = document.createElement('canvas'); raw.width=w; raw.height=visibleH;
      raw.getContext('2d')!.putImageData(new ImageData(rgba,w,visibleH),0,0);
      const out = document.createElement('canvas'), scale = Math.min(1,512/w,720/visibleH);
      out.width=Math.round(w*scale); out.height=Math.round(visibleH*scale);
      const ctx=out.getContext('2d')!;
      ctx.fillStyle='#f4f1ec'; ctx.fillRect(0,0,out.width,out.height);
      ctx.drawImage(raw,0,0,out.width,out.height);
      return out.toDataURL('image/jpeg',.86);
    } catch { return null; }
  }

  /**
   * 把整只模型塞进画布（按包围盒等比缩放、水平居中、底部对齐）。
   * 不能直接用 model.width/height 算缩放：Cubism 模型的 width 是"单位数"
   * （canvas 1024 / PixelsPerUnit 1024 = 1），和实际渲染尺寸不是一个量纲，
   * 会把模型放大到只剩腿。这里改成量实际包围盒来适配。
   * @returns 是否成功（失败时调用方不要接着做紧贴适配）
   */
  private fitByBounds(w: number, h: number): boolean {
    const model = this.model;
    try {
      model.anchor?.set?.(0, 0);
      model.scale.set(1);
      model.position.set(0, 0);
      const b = model.getBounds?.();
      if (b && b.width > 0 && b.height > 0) {
        const s = Math.min(w / b.width, h / b.height);
        model.scale.set(s);
        const b2 = model.getBounds();
        model.position.set(w / 2 - (b2.x + b2.width / 2), h - (b2.y + b2.height));
        if (!this.fittedOnce) {
          this.fittedOnce = true;
          console.log(
            `[render] Live2D 适配: 舞台 ${w}x${h}, 模型包围盒 ${b.width.toFixed(1)}x${b.height.toFixed(1)}, ` +
              `缩放 ${s.toFixed(3)}, 画布 ${model.internalModel?.coreModel?.canvasinfo?.CanvasWidth ?? "?"}`,
          );
        }
        return true;
      }
    } catch (e) {
      console.warn("[render] Live2D 包围盒适配失败，回退尺寸估算：", e);
    }
    const ci = model.internalModel?.coreModel?.canvasinfo;
    const nw = ci?.CanvasWidth || model.width || 1;
    const nh = ci?.CanvasHeight || model.height || 1;
    const s = Math.min(w / nw, h / nh);
    model.scale.set(s);
    model.position.set(w / 2, h);
    return false;
  }

  /**
   * 量"真正画出来的像素"范围（读当前帧的 alpha 通道），
   * 另外量出"两只脚之间的中点"和脚底位置。
   * 模型的包围盒里有一大片透明区域，直接拿它当尺寸会让立绘显得又小又飘；
   * 而脚在待机动作里是不动的，用它来居中/对齐比用整幅（头发会摆）稳得多。
   */
  private measureDrawnBox(): {
    x: number;
    y: number;
    w: number;
    h: number;
    feetMid: number;
    bottom: number;
  } | null {
    const app: any = this.app;
    const gl = app?.renderer?.gl;
    if (!gl || !this.canvas.clientWidth) return null;
    try {
      app.renderer.render(app.stage); // 保证缓冲里就是这一帧，否则可能读到空
    } catch {
      return null;
    }
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    if (!W || !H) return null;
    const buf = new Uint8Array(W * H * 4);
    try {
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    } catch {
      return null;
    }
    let x0 = W;
    let y0 = H; // gl 坐标里"最小的行"＝最底部
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if (buf[row + x * 4 + 3] > 40) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    // 脚：取最底部一小条里左右边界的中点（这条里只有鞋和脚踝）
    const band = Math.min(24, Math.max(3, Math.round((y1 - y0 + 1) * 0.08)));
    let fx0 = W;
    let fx1 = -1;
    for (let y = y0; y < Math.min(H, y0 + band); y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if (buf[row + x * 4 + 3] > 40) {
          if (x < fx0) fx0 = x;
          if (x > fx1) fx1 = x;
        }
      }
    }
    const feetPx = fx1 >= fx0 ? (fx0 + fx1) / 2 : (x0 + x1) / 2;
    const k = W / this.canvas.clientWidth; // 绘制缓冲像素 → CSS 像素
    // WebGL 原点在左下，转成"左上为原点"的 CSS 坐标
    return {
      x: x0 / k,
      y: (H - 1 - y1) / k,
      w: (x1 - x0 + 1) / k,
      h: (y1 - y0 + 1) / k,
      feetMid: feetPx / k,
      bottom: (H - 1 - y0) / k,
    };
  }

  /**
   * 小窗用：让"实际画出来的立绘"正好填满容器（四周只留 pad 的余量），
   * 于是容器 = 立绘的框，外层窗口贴着它，判定框也就贴着立绘了。
   *
   * 要点：
   * ① 先"整只塞进画布"再量，否则一旦已经裁掉一部分，量到的框就是残缺的，
   *    按世界坐标算会越算越偏（踩过：只剩裙子，头在画布上方）。
   * ② 横向按"两只脚之间的中点"对齐中线、纵向按脚底对齐底部：脚在待机动作里不动，
   *    拿整幅居中会被头发摆动带偏（踩过：稳定偏右 10px，看着就是没居中）。
   */
  private fitTight(w: number, h: number): void {
    const model = this.model;
    if (!model) return;
    // 四周留白（px）。头发摆动大约 ±6px，留 10px 足够不切边。
    const pad = 10;
    this.fitByBounds(w, h); // 先整只塞进画布，量出来的才是完整立绘
    const m = this.measureDrawnBox();
    if (!m || m.w < 2 || m.h < 2) return;
    const pos = model.position;
    const s0 = model.scale.x;
    // 世界坐标 → 模型局部坐标（与当前缩放/位移无关）
    const lw = m.w / s0;
    const lh = m.h / s0;
    const feetLocal = (m.feetMid - pos.x) / s0;
    const bottomLocal = (m.bottom - pos.y) / s0;
    const s = Math.min((w - pad * 2) / lw, (h - pad * 2) / lh);
    if (!(s > 1e-4 && s < 1e6)) return;
    model.scale.set(s);
    model.position.set(w / 2 - feetLocal * s, h - pad - bottomLocal * s);
    const check = this.measureDrawnBox();
    if (check) {
      (window as any).__petFit = {
        w,
        h,
        pad,
        s,
        box: { w: m.w, h: m.h },
        feetMid: m.feetMid,
        check: { w: check.w, h: check.h, feetMid: check.feetMid },
      };
    }
  }

  private onMouse = (e: MouseEvent): void => {
    if (this.animator) { this.followCursor(e.clientX,e.clientY); return; }
    try {
      this.model?.focus?.(e.clientX, e.clientY);
    } catch {}
  };

  private onDesktopCursor = (e: Event): void => {
    const p = (e as CustomEvent<{x:number;y:number}>).detail;
    if (p) this.followCursor(p.x,p.y);
  };

  private followCursor(x: number, y: number): void {
    const r = this.element.getBoundingClientRect();
    this.animator?.setGaze((x-r.left-this.face.x)/Math.max(80,r.width*.6),
      -(y-r.top-this.face.y)/Math.max(80,r.height*.6));
  }

  play(anim: PetAnim): void {
    if (this.animator) { this.animator.play(anim); return; }
    const model = this.model;
    if (!model) return;
    const m = this.resolveMotion(anim);
    if (!m) return;
    try {
      model.motion?.(m);
    } catch {}
    try {
      const ex = EXPRESSIONS[anim];
      if (ex) model.expression?.(ex);
    } catch {}
  }

  /** 把桌宠的动作语义映射到模型实际有的动作组（按优先级挑第一个存在的） */
  private resolveMotion(anim: PetAnim): string | null {
    const prefer = MOTION_PREFERENCE[anim];
    if (!prefer) return null;
    const groups = this.motionGroups;
    if (!groups.length) return prefer[0] ?? null; // 拿不到动作表时按第一个偏好名试
    for (const want of prefer) {
      const hit = groups.find((g) => g.toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
    // 都没有就退回 Idle 类动作，再不济退回第一个动作组
    const idle = groups.find((g) => /idle/i.test(g));
    return idle ?? groups[0] ?? null;
  }

  speak(on: boolean): void {
    this.speaking = on;
    if (this.animator) return;
    if (on) {
      const step = () => {
        if (!this.speaking || !this.model) return;
        const v = (Math.sin(performance.now() / 120) + 1) / 2;
        try {
          this.model.internalModel?.coreModel?.setParameterValueById?.("ParamMouthOpenY", v * 0.8);
        } catch {}
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    } else {
      cancelAnimationFrame(this.raf);
      try {
        this.model?.internalModel?.coreModel?.setParameterValueById?.("ParamMouthOpenY", 0);
      } catch {}
    }
  }

  setTone(tone: PetTone): void {
    this.animator?.setTone(tone);
    this.canvas.dataset.tone = tone;
    this.canvas.style.filter =
      tone === "warm"
        ? "saturate(1.1) brightness(1.03)"
        : tone === "cool"
          ? "saturate(0.9) brightness(0.99)"
          : tone === "angry"
            ? "saturate(1.3) hue-rotate(-8deg)"
            : "none";
  }

  dispose(): void {
    this.speaking = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMouse);
    window.removeEventListener('pet:cursor', this.onDesktopCursor);
    window.removeEventListener("resize", this.resize);
    try {
      this.ro?.disconnect();
    } catch {}
    try {
      this.app?.destroy?.(true, { children: true });
    } catch {}
    this.element.remove();
  }
}
