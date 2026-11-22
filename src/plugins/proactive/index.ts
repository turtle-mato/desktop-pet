// 主动搭话：只根据当前可靠事件、具名活动或用户启用的例行功能判断；没有由头就保持安静。
//
// 踩过的坑：
// - 不把空闲、沉默或默认时段当作个人事实，不用"在干嘛"之类的兜底问题填空。
// - 屏幕感知开启但没有可靠新内容时继续等待，不退回计时器式泛聊。
// - 生成一句话要好几秒，5 秒一轮会并发叠上去，所以用 busy 挡住重入。
// - 她回答"这轮先不开口"时 generate 返回空串，这时不该记成"已经聊过"。
import type { PetPlugin } from "../../core/pluginManager";
import { now } from "../../core/session";
import { screenContent, screenFingerprint, freshScreenMoment, freshBackgroundMedia, type ScreenContextState } from "../../chat/screenContext";
import { inQuietHours, screenDue } from "./timing";
import { backgroundMediaKey } from "../../chat/screenPolicy";
import {routineSlot,routineQuietException,routineDate} from "./routines";

type ScreenSnapshot = ScreenContextState;

export default {
  manifest: {
    id: "proactive",
    name: "主动搭话",
    version: "0.2.0",
    order: 5,
    config: {
      enabled: true,
      dailyRoutinesEnabled: true,
      gameTalkMin: 8, // 玩游戏但一直没聊天时会聊游戏
      minGapMin: 6, // 两次主动搭话最小间隔
      screenTalkMin: 2, // 屏幕换到新画面后，稳定这么久就顺着它开口
      screenRepeatMin: 12, // 同一画面一直没变，隔这么久可以再提一句
      userQuietSec: 45, // 对方刚说完话的这段时间里不插嘴
      quietStartHour: 23, // 23:00 - 7:00 不主动打扰
      quietEndHour: 7,
    },
    description: "只围绕可靠的新事件、具名活动或已启用的例行功能主动回应；没有具体由头时保持安静",
  },
  publicApi: {} as any,
  init(ctx) {
    let lastAction = Date.now();
    let lastUser = Date.now();
    let lastPet = Date.now();
    let counter = 0;
    let busy = false;
    let lastAttempt = 0;
    let lastGameAttempt = 0;
    const remoteThinking = new Map<string, number>();
    ctx.bus.on("chat:remote-thinking", (e: any) => {
      if (!e?.from) return;
      if (e.on) remoteThinking.set(e.from, now()); else remoteThinking.delete(e.from);
    });

    // 屏幕这边：记当前画面指纹，以及"上一次顺着屏幕开口"的时间
    let screenKey = "";
    let screenChangedAt = Date.now();
    let lastScreenTalk = 0;
    let lastScreenKey = "";
    let lastMomentAt = 0;
    let lastMomentKey = "";
    let lastBackgroundKey = "";
    let lastBackgroundAt = 0;
    const SUCCESS_KEY = "desktop-pet.v1.proactive.success";
    const syncSuccess = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(SUCCESS_KEY) || "null");
        if (saved && Number.isFinite(saved.at)) lastAction = Math.max(lastAction, saved.at);
        if (saved && Number.isFinite(saved.screenAt) && saved.screenAt > lastScreenTalk) {
          lastScreenTalk = saved.screenAt; lastScreenKey = String(saved.screenKey || "");
        }
        if (saved && Number.isFinite(saved.momentAt) && saved.momentAt > lastMomentAt) {
          lastMomentAt = saved.momentAt; lastMomentKey = String(saved.momentKey || "");
        }
        if (saved && Number.isFinite(saved.backgroundAt) && saved.backgroundAt > lastBackgroundAt) {
          lastBackgroundAt = saved.backgroundAt; lastBackgroundKey = String(saved.backgroundKey || "");
        }
      } catch {}
    };

    ctx.bus.on("chat:user", () => (lastUser = now()));
    ctx.bus.on("activity:changed", () => { lastGameAttempt = 0; });
    ctx.bus.on("chat:pet", () => (lastPet = now()));
    document.addEventListener("input", (e) => {
      if ((e.target as HTMLElement)?.matches("input, textarea, [contenteditable=true]")) {
        lastUser = now();
        localStorage.setItem("desktop-pet.v1.proactive.typing", String(lastUser));
      }
    });
    const userBusy = () => {
      const el = document.activeElement as HTMLInputElement | null;
      return ctx.chat.isThinking || [...remoteThinking.values()].some((at) => now() - at < 180_000) ||
        now() - Number(localStorage.getItem("desktop-pet.v1.proactive.typing") || 0) < ctx.config.userQuietSec * 1000 ||
        !!(el?.matches("input, textarea, [contenteditable=true]") && (el.value || el.textContent || "").trim());
    };

    // 两个窗口都会跑这段（小窗常显、主窗有自己的界面）。谁真的开口要跨窗口商量，
    // 否则同时开着大小窗时她会把同一句话说两遍。
    const CLAIM_KEY = "desktop-pet.v1.proactive.claim";
    const claimSeconds = 90;
    const claimFresh = () => {
      const t = Number(localStorage.getItem(CLAIM_KEY) || 0);
      return Date.now() - t < claimSeconds * 1000;
    };
    const takeClaim = () => {
      if (claimFresh()) return false;
      localStorage.setItem(CLAIM_KEY, String(Date.now()));
      return true;
    };

    const minsBy = (t: number) => (now() - t) / 60000;
    const inQuiet = () => {
      const h = new Date().getHours();
      const s = ctx.config.quietStartHour;
      const e = ctx.config.quietEndHour;
      return inQuietHours(h, s, e);
    };

    const routineAllowed=(type:string)=>{
      const slot=routineSlot();return ctx.config.dailyRoutinesEnabled!==false && type===`routine-${slot}` &&
        (!inQuiet() || routineQuietException(slot,ctx.config.quietStartHour,ctx.config.quietEndHour));
    };
    const screenOf = (): ScreenSnapshot | null => {
      const api = ctx.api["screen-awareness"] as { snapshot?: () => ScreenSnapshot } | undefined;
      const s = api?.snapshot?.();
      if (!screenContent(s)) return null;
      return s;
    };

    /**
     * 说一句。返回是否真的说出去了。
     * 门槛是"上次主动开口"的间隔；她决定不说时不算数，也不会顶掉下一次机会。
     * minGap 单独给：顺着屏幕说话有自己的节奏，别被 6 分钟的全局间隔吃掉。
     */
    const tryAct = async (
      type: string,
      opts: Record<string, unknown> = {},
      minGap = ctx.config.minGapMin,
    ): Promise<boolean> => {
      if (busy || userBusy() || now() - lastAttempt < 60_000) return false;
      syncSuccess();
      if (minsBy(lastAction) < minGap) return false;
      busy = true;
      const sourceWindowKey = type === "screen" ? screenKey : "";
      const sourceMomentKey = (opts.screenMoment as any)?.key;
      const sourceBackground = opts.backgroundMedia as any;
      const sourceBackgroundKey = sourceBackground ? backgroundMediaKey(sourceBackground) : "";
      const act = async () => {
        if(type.startsWith("routine-") && !routineAllowed(type))return false;
        if (userBusy() || !takeClaim()) return false;
        lastAttempt = now();
        const t = await ctx.chat.generate(type, opts);
        const text = String(t || "").trim();
        if (!text) return false;
        if ((inQuiet() && !(type.startsWith("routine-") && routineAllowed(type))) || (type.startsWith("routine-") && !routineAllowed(type)) || ctx.config.enabled===false || userBusy() || document.visibilityState === "hidden" ||
          now() - lastUser < ctx.config.userQuietSec * 1000) return false;
        if (type === "screen") {
          const snapshot = ctx.api["screen-awareness"]?.snapshot?.();
          if ((snapshot?.attentionMode === "work" && minGap < 45) || snapshot?.attentionMode === "idle") return false;
          if (sourceBackgroundKey) {
            const currentMedia = freshBackgroundMedia(snapshot);
            if (!currentMedia || backgroundMediaKey(currentMedia) !== sourceBackgroundKey) return false;
          } else {
            const latest = screenOf();
            if (!latest || screenFingerprint({ ...latest, summary: "" }) !== sourceWindowKey) return false;
            if (sourceMomentKey && freshScreenMoment(latest)?.key !== sourceMomentKey) return false;
          }
        }
        ctx.chat.sayPet(text, "initiative");
        lastAction = lastPet = now();
        if (type === "screen") { lastScreenTalk = now(); lastScreenKey = screenKey; }
        if (sourceMomentKey) { lastMomentAt = now(); lastMomentKey = sourceMomentKey; }
        if (sourceBackgroundKey) { lastBackgroundAt = now(); lastBackgroundKey = sourceBackgroundKey; }
        localStorage.setItem(SUCCESS_KEY, JSON.stringify({ at: lastAction, screenAt: lastScreenTalk, screenKey: lastScreenKey,
          momentAt: lastMomentAt, momentKey: lastMomentKey, backgroundAt: lastBackgroundAt, backgroundKey: lastBackgroundKey }));
        return true;
      };
      try {
        // Web Locks 在同源的两个 WebView 间原子抢占；旧运行时仍保留共享租约。
        if (navigator.locks) return await navigator.locks.request("pet-proactive", { ifAvailable: true },
          async (lock) => lock ? act() : false);
        return await act();
      } catch (e) {
        console.warn("[proactive] 本轮未能生成：", e);
        return false;
      } finally {
        busy = false;
      }
    };

    ctx.bus.on("tick:1s", () => {
      if (ctx.config.enabled === false) return;
      counter += 1;
      if (counter % 5 !== 0) return; // 每 5 秒评估一次
      const slot=routineSlot();
      if(inQuiet() && !(ctx.config.dailyRoutinesEnabled!==false && routineQuietException(slot,ctx.config.quietStartHour,ctx.config.quietEndHour)))return;
      if (busy || userBusy()) return;
      syncSuccess();
      // 窗口被隐藏（比如主窗收进小窗）时不许说话：两边都隐藏还开口，就没人看得见了
      if (document.visibilityState === "hidden") return;
      // 对方刚说完话，让对话先走完
      if (now() - lastUser < ctx.config.userQuietSec * 1000) return;

      // ---- 1) 有屏幕内容：她看得见，就优先把话题落在屏幕上 ----
      const snapshot = ctx.api["screen-awareness"]?.snapshot?.() as ScreenSnapshot | undefined;
      if(slot && ctx.config.dailyRoutinesEnabled!==false && !(snapshot?.enabled && snapshot.attentionMode==="idle") && minsBy(lastPet)>=2 && minsBy(lastUser)>=2){
        const date=routineDate(),key=`desktop-pet.v1.routine.${slot}`;
        let prev:{date?:string;at?:number;said?:boolean;attempts?:number}|null=null;
        try{prev=JSON.parse(localStorage.getItem(key)||"null");}catch{}
        if((!prev || prev.date!==date || (!prev.said && (prev.attempts||0)<3 && now()-(prev.at||0)>=30*60_000)) && minsBy(lastAction)>=2 && !claimFresh()){
          const marker={date,at:now(),attempts:prev?.date===date ? (prev.attempts||0)+1 : 1};
          localStorage.setItem(key,JSON.stringify(marker));
          void tryAct(`routine-${slot}`,{},2).then(said=>{if(said)localStorage.setItem(key,JSON.stringify({...marker,said:true}));});return;
        }
      }
      if(inQuiet())return;
      // Reuse today's notes even if collection is now off; never take a fresh
      // screenshot for the evening conversation. Quiet/typing gates still apply.
      const evening = new Date();
      const dayKey = `${evening.getFullYear()}-${evening.getMonth()}-${evening.getDate()}`;
      const dayAttemptKey = "desktop-pet.v1.screen-day.attempt";
      if (ctx.config.dailyRoutinesEnabled===false && (evening.getHours() > 21 || (evening.getHours() === 21 && evening.getMinutes() >= 30)) &&
        snapshot?.attentionMode !== "idle" && minsBy(lastPet) >= 10 && minsBy(lastUser) >= 2 &&
        ctx.api["screen-journal"]?.enabled?.() !== false) {
        let previous: any;
        try { previous = JSON.parse(localStorage.getItem(dayAttemptKey) || "null"); } catch {}
        if (!previous || previous.date !== dayKey || (!previous.said && now() - previous.at >= 30 * 60_000)) {
          localStorage.setItem(dayAttemptKey, JSON.stringify({ date: dayKey, at: now() }));
          void tryAct("screen-day", {}, 10).then(said => {
            if (said) localStorage.setItem(dayAttemptKey, JSON.stringify({ date: dayKey, at: now(), said: true }));
          });
          return;
        }
      }
      // Idle means no confirmed playback. Remain quiet rather than nag an empty desk.
      if (snapshot?.attentionMode === "idle") return;
      const s = screenOf();
      if (s) {
        // 计时看窗口/页面，不要求游戏 HUD、视频字幕或滚动文字两分钟不变。
        const key = screenFingerprint({ ...s, summary: "" });
        if (key !== screenKey) {
          screenKey = key;
          screenChangedAt = now();
        }
        const moment = freshScreenMoment(s);
        if (moment) {
          if (now() - screenChangedAt >= 15_000 && (moment.key !== lastMomentKey || now() - lastMomentAt >= 600_000)) {
            void tryAct("screen", { screenMoment: moment }, snapshot?.attentionMode === "entertainment" ? 2 : 3);
          }
          return;
        }
        // 娱乐内容只接具体画面，不拿菜单/HUD/模糊总结硬聊。新识别未理解时先等待。
        const background = freshBackgroundMedia(snapshot);
        if (background && !["game", "anime", "video"].includes(s.pageType || "")) {
          const mediaKey = backgroundMediaKey(background);
          if (mediaKey !== lastBackgroundKey || now() - lastBackgroundAt >= 20 * 60_000) {
            void tryAct("screen", { backgroundMedia: background }, 2);
          }
          return;
        }
        if (["game", "anime", "video"].includes(s.pageType || "") ||
          (s.understandingStatus && s.understandingStatus !== "ready")) return;
        const wait = snapshot?.attentionMode === "work" ? 45 : snapshot?.attentionMode ? 30 : ctx.config.screenTalkMin;
        if (screenDue(now(), screenChangedAt, key, lastScreenKey, lastScreenTalk,
          wait, Math.max(wait, ctx.config.screenRepeatMin))) void tryAct("screen", {}, wait);
        // 屏幕在看、但此刻不具备开口条件：别退回"你在干嘛"那套，那样等于没看屏幕
        return;
      }
      const background = freshBackgroundMedia(snapshot);
      if (background) {
        const key = backgroundMediaKey(background);
        if (key !== lastBackgroundKey || now() - lastBackgroundAt >= 20 * 60_000) void tryAct("screen", { backgroundMedia: background }, 2);
        return;
      }
      screenKey = ""; screenChangedAt = now();
      // 已开启但暂停/过期时，先等新观察，避免突然改问“你在干嘛”。
      if (ctx.api["screen-awareness"]?.snapshot?.()?.enabled) return;

      // ---- 2) Screen off: only a user-selected, named activity can be a topic. ----
      const kind = ctx.session.activity.kind;
      if (kind === "game" && ctx.session.activity.label?.trim() &&
        minsBy(lastPet) >= ctx.config.gameTalkMin && now() - lastGameAttempt >= 20 * 60_000) {
        lastGameAttempt = now();
        void tryAct("game");
      }
    });
  },
} as PetPlugin;
