export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

export function screenDue(at: number, changedAt: number, key: string, lastKey: string,
  lastTalk: number, settleMinutes: number, repeatMinutes: number): boolean {
  const settle = Math.max(0, settleMinutes) * 60_000;
  const gap = Math.max(settleMinutes, key === lastKey ? repeatMinutes : settleMinutes) * 60_000;
  return at - changedAt >= settle && (!lastTalk || at - lastTalk >= gap);
}
