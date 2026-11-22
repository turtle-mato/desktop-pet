import type { EventBus } from "./bus";

type Events = {
  emit(name: string, payload: any): Promise<void>;
  listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};
type Request = { from: string; id: string; enabled: boolean };
type Reply = { id: string; snapshot?: any; error?: string };

/** Only main owns collection. Mini must never toggle its own dormant plugin/native state. */
export async function installScreenControl(api: Record<string, any>, _bus: EventBus, mini: boolean, events: Events) {
  if (!mini) {
    return events.listen<Request>("pet:screen-control", ({ payload: p }) => {
      if (!p || p.from !== "mini" || typeof p.id !== "string" || typeof p.enabled !== "boolean") return;
      void (async () => {
        let error = "";
        try { await api["screen-awareness"].setEnabled(p.enabled); }
        catch (e) { error = String(e); }
        await events.emit("pet:screen-control-result", { id: p.id, snapshot: api["screen-awareness"]?.snapshot?.(), error });
      })().catch(console.warn);
    });
  }
  const pending = new Map<string, { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const unlisten = await events.listen<Reply>("pet:screen-control-result", ({ payload: p }) => {
    const task = pending.get(p?.id);
    if (!task) return;
    pending.delete(p.id); clearTimeout(task.timer);
    // Snapshots are delivered by the ordered pet:screen stream. An acknowledgement
    // may lag behind a newer toggle, so must not overwrite that stream's state.
    p.error ? task.reject(Error(p.error)) : task.resolve();
  });
  api["screen-awareness"] = {
    ...api["screen-awareness"],
    setEnabled: (enabled: boolean) => new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(Error("主窗口尚未确认读屏开关，请稍后重试")); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      void events.emit("pet:screen-control", { from: "mini", id, enabled }).catch(e => {
        clearTimeout(timer); pending.delete(id); reject(Error(String(e)));
      });
    }),
  };
  return () => {
    unlisten();
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error("读屏控制已断开")); }
    pending.clear();
  };
}
