/** Retry hydration after mind becomes ready; one successful load per window. */
export function createRecentChatRestorer(deps: {
  usable: () => Promise<boolean>;
  recent: () => Promise<{ items?: Array<{ role: string; text?: string; ts?: number }> }>;
  thinking: () => boolean;
  apply: (turns: Array<{ role: "user" | "assistant"; text: string; ts: number }>) => number;
}) {
  let loaded = false;
  let pending: Promise<boolean> | undefined;
  return function restore(): Promise<boolean> {
    if (loaded) return Promise.resolve(true);
    if (pending) return pending;
    pending = (async () => {
      try {
        if (deps.thinking() || !(await deps.usable())) return false;
        const result = await deps.recent();
        if (!Array.isArray(result?.items) || deps.thinking()) return false;
        const turns = result.items
          .filter(m => (m.role === "user" || m.role === "pet" || m.role === "assistant") && String(m.text || "").trim())
          .map(m => ({ role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant", text: String(m.text), ts: Number(m.ts) || 0 }));
        const count = deps.apply(turns);
        console.log(`[chat] 已恢复 ${count} 条最近聊天记录`);
        loaded = true;
        return true;
      } catch (error) {
        console.warn("[chat] 聊天记录暂未恢复，下次连接成功后重试：", error);
        return false;
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
