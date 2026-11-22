import type { MindConfig } from "./config.ts";
import { localWeather } from "./weather.ts";
export type Routine = "morning" | "evening" | "sleep";
export function routineKind(reason?: string): Routine | null {
  return reason === "routine-morning" ? "morning" : reason === "routine-evening" ? "evening" : reason === "routine-sleep" ? "sleep" : null;
}
export function routineOpen(kind: Routine, at = new Date()): boolean {
  const m = at.getHours()*60+at.getMinutes();
  return kind === "morning" ? m>=7*60 && m<12*60 : kind === "evening" ? m>=21*60+30 && m<23*60 : m>=23*60;
}
export function sleepException(kind: Routine | null, cfg: MindConfig): boolean {
  // Never bypass a user's earlier/custom quiet schedule.
  return kind === "sleep" && cfg.proactive.quietStartHour === 23 && cfg.proactive.quietEndHour === 7;
}
export function declinedSleep(history: Array<{role:string;content:string;at?:number}> = [], at = new Date()): boolean {
  for (const m of [...history].reverse()) {
    if (m.role!=="user" || (Number.isFinite(m.at) && new Date(m.at!).toDateString()!==at.toDateString())) continue;
    if (/(?:别|不要|不用|不许|不准).{0,4}(?:催|提醒|叫|劝).{0,8}(?:睡|休息)|(?:睡|休息).{0,8}(?:别催|不用提醒|别提醒)|(?:准备|马上|这就|已经)?(?:去睡了|睡觉去了|睡了|晚安)/.test(m.content)) return true;
    // A newer explicit request can revoke an earlier refusal.
    if (/(?:提醒|叫|催).{0,8}(?:睡觉|睡|休息)/.test(m.content)) return false;
  }
  return false;
}
export async function routineTopic(kind: Routine, cfg: MindConfig, date: string, notes: string) {
  const key = `routine:${kind}:${date}`;
  if (kind === "morning") {
    const weather = cfg.proactive.dailyRoutines?.weather === false
      ? "未启用天气查询。不编天气，不假称查过。" : (await localWeather()).text;
    return {kind:"daily" as const,key,material:weather,
      hint:"晨间随口搭话：天气可靠时先用两句短话说网络定位的城市、今天预报和一条有依据的出门小提醒，再最多问一句今天打算做什么。哥哥在历史里说过安排就接那个安排，不重复问。查不到天气就坦白一句，不拿其他城市兜底。参考口吻而非固定台词：哥，今天准备先忙哪件？不要播报气象站，不扮演管家婆。"};
  }
  if (kind === "evening") {
    if (!notes.trim()) return null;
    return {kind:"daily" as const,key,
      material:notes,
      hint:"晚间只从当天确实记录到的一件小事接话；不复述整天行程，不评价效率，不推断完成情况或心情。用一句短话自然回应，没什么值得接就 [SKIP]。"};
  }
  return {kind:"daily" as const,key,material:"现在已过23点。这是今晚唯一一次睡前搭话；不知道哥哥是否困、明早几点起床或是否仍在电脑旁。",
    hint:"轻轻提醒准备睡觉，一两句就收，不再追问、不卖惨、不命令关机。参考口吻：哥，十一点过了。存个档，准备收工？如果他说在忙/还不睡，不反驳、不催第二次；如果最近明确说不要催睡，就输出[SKIP]。不假装自己躺床上或有身体。"};
}
