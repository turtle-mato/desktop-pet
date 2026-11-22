import type { PetPlugin } from "../../core/pluginManager";
import { mindRecordScreenDay } from "../../mind/client";
import { isSensitiveObservationText } from "../../chat/screenObservation";
const plugin: PetPlugin = {
  manifest: { id: "screen-journal", name: "读屏日记", order: 25, config: { enabled: true },
    description: "只保留当天可靠画面摘要，不存截图或逐字OCR；晚上据此自然搭话。" },
  init(ctx) {
    plugin.publicApi = ctx.api["screen-journal"] = { enabled: () => ctx.config.enabled !== false };
    let running = false, busy = false, lastAt = 0;
    plugin.start = () => { running = true; };
    plugin.stop = () => { running = false; };
    ctx.bus.on("screen:status", (s: any) => {
      if (!running || ctx.config.enabled === false || busy || !s?.enabled || s.status !== "watching" || s.pauseReason ||
        s.understandingStatus !== "ready" || Date.now() - lastAt < 300_000) return;
      const at = Number(s.understandingAt), summary = String(s.aiSummary || "").trim();
      if (!at || at > Date.now() || Date.now() - at > 105_000 || summary.length < 5 || summary.length > 240 ||
        isSensitiveObservationText(summary) || !s.pageType || s.pageType === "uncertain") return;
      busy = true; lastAt = Date.now();
      // Never sends image, title, OCR, subtitle, process list or background media.
      void mindRecordScreenDay({ capturedAt: at, pageType: s.pageType, summary })
        .catch(() => ctx.log("本次读屏日记未保存；不缓存、不补传旧画面"))
        .finally(() => { busy = false; });
    });
  },
};
export default plugin;
