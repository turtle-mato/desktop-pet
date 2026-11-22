// 调度器：空闲判定 + 队列推进（老的优先，跨天补跑）+ 回收站轮转 + 每日备份
// 主人定的规则：不搞定点定时，**次日任意空闲时刻**把前一天总结掉
import type { MindConfig } from "./config.ts";
import {
  loadQueue, loadState, saveState, refillQueueFromRaw, purgeTrash, backupNow,
  digestExists, dateStr, type RuntimeState,
} from "./store.ts";
import { summarizeDate, type SummaryOutcome } from "./summarize.ts";

export interface IdleVerdict {
  idle: boolean;
  reason: string;
}

/** 是否处于"可以干活"的空闲状态 */
export function isIdle(cfg: MindConfig, state: RuntimeState, now = Date.now()): IdleVerdict {
  const sinceActivity = (now - (state.lastActivityTs || 0)) / 60000;
  const sinceStart = (now - (state.startedAt || now)) / 60000;
  const sinceSummary = (now - (state.lastSummaryAt || 0)) / 60000;

  if (sinceStart < cfg.startupGraceMinutes) {
    return { idle: false, reason: `启动未满 ${cfg.startupGraceMinutes} 分钟` };
  }
  if (sinceActivity < cfg.idleMinutes) {
    return { idle: false, reason: `刚刚还在聊天（${sinceActivity.toFixed(1)} 分钟前）` };
  }
  if (sinceSummary < cfg.summaryCooldownMinutes) {
    return { idle: false, reason: `距上次总结仅 ${sinceSummary.toFixed(1)} 分钟` };
  }
  return { idle: true, reason: `空闲 ${sinceActivity.toFixed(1)} 分钟` };
}

export interface TickResult {
  note: string;
  refilled?: string[];
  purged?: string[];
  backedUp?: string;
  summary?: SummaryOutcome;
}

/** 一次调度心跳 */
export async function tick(cfg: MindConfig, opts: { manual?: boolean } = {}): Promise<TickResult> {
  const state = loadState();
  const today = dateStr();

  // ① 补跑：把"今天之前、还没总结"的 raw 补进队列
  const refilled = refillQueueFromRaw();

  // ② 每日维护（回收站轮转 + 备份），每天各做一次
  let purged: string[] | undefined;
  let backedUp: string | undefined;
  if (state.lastPurgeDate !== today) {
    purged = purgeTrash(cfg.trashDays);
    saveState({ lastPurgeDate: today });
  }
  if (state.lastBackupDate !== today) {
    try {
      backedUp = backupNow();
      saveState({ lastBackupDate: today });
    } catch {
      /* 备份失败不影响主流程 */
    }
  }

  // ③ 空闲才总结，且**一次只做一天**（老的优先）
  const q = loadQueue();
  const due = q.dates.filter((d) => d < today && !digestExists(d));
  if (!due.length) {
    return { note: "没有待总结的日子", refilled, purged, backedUp };
  }

  if (!opts.manual) {
    const verdict = isIdle(cfg, loadState());
    if (!verdict.idle) {
      return { note: `待总结 ${due.length} 天，但当前不空闲（${verdict.reason}）`, refilled, purged, backedUp };
    }
  }

  const date = due[0];
  const summary = await summarizeDate(date, cfg, opts.manual === true);
  return { note: `处理 ${date}：${summary.note}`, refilled, purged, backedUp, summary };
}

/** 启动调度循环（默认每 30 秒一跳） */
export function startScheduler(
  cfg: MindConfig,
  onEvent?: (r: TickResult) => void,
  intervalMs = 30_000,
): () => void {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try {
      const r = await tick(cfg);
      if (r.summary || r.purged?.length || r.refilled?.length) onEvent?.(r);
    } catch (e) {
      console.error("[scheduler] tick 出错：", (e as Error).message);
    } finally {
      if (!stopped) setTimeout(loop, intervalMs);
    }
  };
  saveState({ startedAt: Date.now() });
  void loop();
  return () => {
    stopped = true;
  };
}
