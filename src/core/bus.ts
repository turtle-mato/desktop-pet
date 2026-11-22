// 事件总线：发布/订阅（docs/教程/第06课）
type Handler = (payload: any) => void;

export class EventBus {
  private map = new Map<string, Handler[]>();

  on(name: string, fn: Handler): () => void {
    if (!this.map.has(name)) this.map.set(name, []);
    this.map.get(name)!.push(fn);
    return () => this.off(name, fn);
  }

  off(name: string, fn: Handler): void {
    const arr = this.map.get(name);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  emit(name: string, payload?: any): void {
    const arr = this.map.get(name);
    if (!arr) return;
    // 拷贝一份，允许在回调里 on/off
    for (const fn of [...arr]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] handler error on "${name}"`, e);
      }
    }
  }
}
