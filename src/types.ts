// 共享类型定义

export type ActivityKind = "work" | "study" | "game" | "rest" | "outside" | "none";

export interface Activity {
  kind: ActivityKind;
  label: string; // 展示名（如"工作"、"原神"）
  since: number; // 开始时间戳(ms)
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  due?: string; // 可选，随意文本（如"今天 17:00"）
  createdAt: number;
}

export interface MemoryRecord {
  id: string;
  kind: "fact" | "preference" | "event"; // 事实 / 偏好 / 事件
  text: string;
  ts: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  text: string;
  ts: number;
}

export interface PersonaState {
  mood?: string;
}
