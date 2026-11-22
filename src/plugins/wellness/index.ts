import type { PetPlugin } from "../../core/pluginManager";
import { now } from "../../core/session";
import type { ActivityKind } from "../../types";

const LIMITS: Partial<Record<ActivityKind, number>> = { work: 90, study: 90, game: 60 };

export default {
  manifest: {
    id: "wellness",
    name: "久坐监督",
    version: "0.1.0",
    order: 4,
    config: { workMin: 90, studyMin: 90, gameMin: 60, enabled: true },
    description: "按当前活动时长，长时间工作/学习/游戏时提醒休息",
  },
  publicApi: {} as any,
  init(ctx) {
    let lastRemindLevel = 0;
    let active = true;

    const limitFor = (kind: ActivityKind): number => {
      const cfg = ctx.config;
      const map: Partial<Record<ActivityKind, number>> = {
        work: cfg.workMin,
        study: cfg.studyMin,
        game: cfg.gameMin,
      };
      return map[kind] ?? 0;
    };

    ctx.bus.on("activity:changed", () => {
      lastRemindLevel = 0;
    });

    ctx.bus.on("tick:1s", () => {
      if (ctx.config.enabled === false) return;
      const kind = ctx.session.activity.kind;
      const limit = limitFor(kind);
      if (!limit) return;
      const mins = ctx.session.minutesOn();
      const levels = Math.floor(mins / limit);
      if (levels > lastRemindLevel) {
        lastRemindLevel = levels;
        void ctx.chat.generate("rest").then((t) => ctx.chat.sayPet(t, "reminder"));
        ctx.bus.emit("wellness:reminded", { kind, mins });
      }
    });

    ctx.chat.addContext(() => {
      const kind = ctx.session.activity.kind;
      const limit = limitFor(kind);
      if (!limit) return "";
      return `久坐监督：${ctx.session.activity.label || kind}已持续 ${ctx.session.minutesOn()} 分钟，每 ${limit} 分钟会提醒休息。`;
    });

    const api = this.publicApi;
    api.lastRemind = () => lastRemindLevel;
    api.setEnabled = (on: boolean) => {
      active = on;
      ctx.setConfig({ enabled: on });
    };
    api.getEnabled = () => ctx.config.enabled !== false;
    active = ctx.config.enabled !== false;
  },
} as PetPlugin;
