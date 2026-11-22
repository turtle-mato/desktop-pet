// 会话与"当前在干嘛"：活动状态 + 时长统计（供久坐/游戏提醒与 AI 话题）
import type { Activity, ActivityKind } from "../types";

export class Session {
  activity: Activity = { kind: "none", label: "", since: Date.now() };

  setActivity(kind: ActivityKind, label?: string): void {
    this.activity = { kind, label: label ?? this.activity.label ?? "", since: Date.now() };
  }

  /** 当前活动已持续分钟 */
  minutesOn(): number {
    return Math.floor((Date.now() - this.activity.since) / 60000);
  }

  secondsOn(): number {
    return Math.floor((Date.now() - this.activity.since) / 1000);
  }
}

export const now = () => Date.now();

export function formatMinutes(min: number): string {
  if (min < 60) {
    const m = Math.floor(min);
    const s = Math.floor((min - m) * 60);
    return `${m}分${s > 0 ? s + "秒" : ""}`;
  }
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}小时${m}分`;
}

export function greetingByHour(h: number): string {
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  if (h < 23) return "晚上好";
  return "夜深了";
}
