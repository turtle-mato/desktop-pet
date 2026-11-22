import type { PetPlugin } from "../../core/pluginManager";
import { now } from "../../core/session";

type Phase = "idle" | "focus" | "break";
const SAVE_KEY = "state";

export default {
  manifest: {
    id: "pomodoro",
    name: "番茄钟",
    version: "0.1.0",
    order: 3,
    config: { focusMin: 25, breakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4 },
    description: "专注/休息计时，到点提醒",
  },
  publicApi: {} as any,
  init(ctx) {
    let phase: Phase = "idle";
    let endAt = 0;
    let cycles = 0;
    let curBreakMin = 0;

    const minutes = (ms: number) => Math.round(ms / 60000);
    const mk = (p: Phase, lenMs: number) => {
      phase = p;
      endAt = now() + lenMs;
    };

    const remainText = (): string => {
      if (phase === "idle") return "";
      const r = Math.max(0, (endAt - now()) / 60000);
      return `${phase === "focus" ? "专注中" : "休息中"}（剩 ${minutes(r)} 分）`;
    };

    const describe = (): string => {
      if (phase === "idle") return "";
      return `番茄钟：${remainText()}，已完成 ${cycles} 个番茄。`;
    };

    const snapshot = () => ({ phase, endAt, cycles, remainingMs: Math.max(0, endAt - now()) });

    const startFocus = () => {
      if (phase === "focus") return;
      mk("focus", ctx.config.focusMin * 60000);
      ctx.bus.emit("pomodoro:changed", snapshot());
      ctx.chat.sayPet(`开始专注 ${ctx.config.focusMin} 分钟啦，我陪你～`, "reminder");
    };

    const startBreak = () => {
      const long = cycles > 0 && cycles % ctx.config.cyclesBeforeLong === 0;
      curBreakMin = long ? ctx.config.longBreakMin : ctx.config.breakMin;
      mk("break", curBreakMin * 60000);
      ctx.bus.emit("pomodoro:changed", snapshot());
    };

    const stop = () => {
      phase = "idle";
      endAt = 0;
      ctx.bus.emit("pomodoro:changed", snapshot());
      ctx.chat.sayPet("番茄钟停啦，随你安排～", "pet");
    };

    const api = this.publicApi;
    api.startFocus = startFocus;
    api.startBreak = startBreak;
    api.stop = stop;
    api.describe = describe;
    api.snapshot = snapshot;

    ctx.bus.on("tick:1s", () => {
      if (phase === "idle") return;
      if (now() >= endAt) {
        if (phase === "focus") {
          cycles += 1;
          ctx.bus.emit("pomodoro:changed", snapshot());
          ctx.chat.sayPet("专注时间到啦！先休息几分钟，活动一下吧～", "reminder");
          startBreak();
        } else {
          ctx.bus.emit("pomodoro:changed", snapshot());
          ctx.chat.sayPet("休息结束，精神满满！要不要再来一个番茄？", "pet");
          phase = "idle";
        }
      }
    });

    ctx.chat.addContext(() => (phase !== "idle" ? describe() : ""));
  },
} as PetPlugin;
