// 简单的本地键值存储（localStorage），带命名空间隔离，JSON 序列化
const PREFIX = "desktop-pet.v1.";

export class KV {
  constructor(private ns = "") {}

  private key(k: string): string {
    return PREFIX + this.ns + "." + k;
  }

  get<T>(k: string, def?: T): T | null {
    try {
      const raw = localStorage.getItem(this.key(k));
      if (raw == null) return def ?? null;
      return JSON.parse(raw) as T;
    } catch {
      return def ?? null;
    }
  }

  set<T>(k: string, v: T): void {
    try {
      localStorage.setItem(this.key(k), JSON.stringify(v));
    } catch (e) {
      console.error("[storage] set failed", e);
    }
  }

  remove(k: string): void {
    try {
      localStorage.removeItem(this.key(k));
    } catch {}
  }

  // 返回以当前命名空间开头的所有键
  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(PREFIX + this.ns + ".")) out.push(k);
    }
    return out;
  }
}
