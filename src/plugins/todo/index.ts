import type { PetPlugin } from "../../core/pluginManager";
import type { TodoItem } from "../../types";
import { now } from "../../core/session";

const KEY = "items";
const NAG_KEY = "lastNagTs";

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default {
  manifest: {
    id: "todo",
    name: "待办清单",
    version: "0.1.0",
    order: 2,
    config: { nagIntervalMin: 30, praise: true },
    description: "维护 Todo 清单，未完成时会提醒监督",
  },
  publicApi: {} as any,
  init(ctx) {
    const load = (): TodoItem[] => ctx.kv.get<TodoItem[]>(KEY, []) ?? [];
    const save = (arr: TodoItem[]) => {
      ctx.kv.set(KEY, arr);
      ctx.bus.emit("todo:changed", { items: arr });
    };

    const stats = () => {
      const arr = load();
      const open = arr.filter((i) => !i.done).length;
      return { open, done: arr.length - open, total: arr.length };
    };

    const describe = (): string => {
      const arr = load();
      const openItems = arr.filter((i) => !i.done);
      if (!openItems.length) return "";
      const first = openItems.slice(0, 3).map((i) => i.text).join("、");
      return `待办还有 ${openItems.length} 项未完成：${first}${openItems.length > 3 ? " 等" : ""}。`;
    };

    const add = (text: string, due?: string): TodoItem => {
      const item: TodoItem = { id: genId(), text: (text || "").trim(), done: false, due, createdAt: now() };
      const arr = load();
      arr.push(item);
      save(arr);
      return item;
    };

    const toggle = (id: string) => {
      const arr = load();
      const it = arr.find((i) => i.id === id);
      if (!it) return;
      it.done = !it.done;
      save(arr);
      if (it.done && ctx.config.praise) {
        ctx.chat.sayPet(`完成「${it.text}」啦，真棒！休息一下下～`, "pet");
      }
    };

    const remove = (id: string) => {
      save(load().filter((i) => i.id !== id));
    };

    const clearDone = () => {
      save(load().filter((i) => !i.done));
    };

    const api = this.publicApi;
    api.list = load;
    api.add = add;
    api.toggle = toggle;
    api.remove = remove;
    api.clearDone = clearDone;
    api.stats = stats;
    api.describe = describe;

    // 未完成任务监督：每隔 nagIntervalMin 提醒一次
    let lastNag = ctx.kv.get<number>(NAG_KEY, 0) ?? 0;
    ctx.bus.on("tick:1s", () => {
      if (!ctx.config.nagIntervalMin) return;
      const open = stats().open;
      if (open <= 0) return;
      const intervalMs = ctx.config.nagIntervalMin * 60000;
      if (now() - lastNag >= intervalMs) {
        lastNag = now();
        ctx.kv.set(NAG_KEY, lastNag);
        void nagOnce(open);
      }
    });

    const nagOnce = async (open: number) => {
      const title = load().find((i) => !i.done);
      const short = title ? title.text.slice(0, 20) : "";
      // 交给统一对话策略判断；如果她决定跳过，不再绕过跳过结果补发另一句。
      const said = await ctx.chat.generate("todoNag", { todoOpen: open, todoFirst: short });
      if (said) {
        ctx.chat.sayPet(said, "reminder");
      }
    };

    // 提供状态给 AI 上下文
    ctx.chat.addContext(() => {
      const s = stats();
      return s.open > 0 ? `待办：还有 ${s.open} 项未完成。` : "";
    });
  },
} as PetPlugin;
