export type Routine = "morning" | "evening" | "sleep";
export function routineSlot(at = new Date()): Routine | null {
  const minutes = at.getHours()*60+at.getMinutes();
  return minutes>=7*60 && minutes<12*60 ? "morning" : minutes>=21*60+30 && minutes<23*60 ? "evening" : minutes>=23*60 ? "sleep" : null;
}
export function routineQuietException(slot: Routine | null, start: number, end: number) {
  return slot === "sleep" && start === 23 && end === 7;
}
export function routineDate(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,"0")}-${String(at.getDate()).padStart(2,"0")}`;
}
