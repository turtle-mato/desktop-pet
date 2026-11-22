// 配置系统：按"分区(section)"存取，带默认值合并；一切平衡/开关在这里调
import { KV } from "./storage";

export type AnyDict = Record<string, any>;
const store = new KV("cfg");

export function getSection<T extends AnyDict = AnyDict>(section: string, defaults: T): T {
  const stored = store.get<Partial<T>>(section, {} as Partial<T>);
  return { ...defaults, ...(stored ?? {}) } as T;
}

export function setSection(section: string, patch: AnyDict): AnyDict {
  const cur = store.get<AnyDict>(section, {}) ?? {};
  const next = { ...cur, ...patch };
  store.set(section, next);
  return next;
}

export function resetSection(section: string): void {
  store.remove(section);
}

// 极简 "安全读文本"
export function asText(v: any, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
