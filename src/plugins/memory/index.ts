import type { PetPlugin } from "../../core/pluginManager";
import type { MemoryRecord } from "../../types";
import { now } from "../../core/session";

const KEY = "records";

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default {
  manifest: {
    id: "memory",
    name: "记忆",
    version: "0.1.0",
    order: 1,
    config: { maxItems: 200, recordUserEvents: true },
    description: "记录对方的话与事实，供 AI 回忆与主动话题使用",
  },
  publicApi: {} as any,
  init(ctx) {
    const max = (cfg: any, v: number) => (typeof cfg.maxItems === "number" ? cfg.maxItems : v);

    const load = (): MemoryRecord[] => ctx.kv.get<MemoryRecord[]>(KEY, []) ?? [];
    const save = (arr: MemoryRecord[]) => {
      ctx.kv.set(KEY, arr);
      ctx.bus.emit("memory:changed");
    };

    const add = (text: string, kind: "fact" | "preference" | "event" = "fact") => {
      const t = (text || "").trim();
      if (!t) return;
      const arr = load();
      arr.unshift({ id: genId(), kind, text: t, ts: now() });
      const cap = max(ctx.config, 200);
      if (arr.length > cap) arr.length = cap;
      save(arr);
    };

    // 简单关键词打分召回
    const recall = (q: string): string => {
      const arr = load();
      if (!q) return "";
      const words = q.split(/[\s,，。、！!？?]+/).filter((w) => w.length >= 2);
      let best = "";
      let bestScore = 0;
      for (const r of arr) {
        let score = 0;
        for (const w of words) if (r.text.includes(w)) score += w.length;
        if (score > bestScore) {
          bestScore = score;
          best = r.text;
        }
      }
      return best;
    };

    const recent = (n = 8): string[] =>
      load()
        .slice(0, n)
        .map((r) => r.text);

    const list = (): MemoryRecord[] => load();
    const clear = () => {
      ctx.kv.remove(KEY);
      ctx.bus.emit("memory:changed");
    };

    const api = this.publicApi;
    api.add = add;
    api.recall = recall;
    api.recent = recent;
    api.list = list;
    api.clear = clear;

    // 自动记录对方说的话（短句/重要内容），作为"事件"记忆
    ctx.bus.on("chat:user", ({ text }) => {
      if (!ctx.config.recordUserEvents) return;
      const t = (text || "").trim();
      if (t.length >= 4) add(t.slice(0, 60), "event");
    });
  },
} as PetPlugin;
