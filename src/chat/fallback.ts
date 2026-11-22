// 本地回复：没连上思维系统（或调用失败）时的"兜底拟声"引擎（按关键词 + 上下文）
//
// 注意：这里说话的不是"她本人"——她的人格/记忆/情绪都在思维系统那边，
// 接不上时只能用这套模板顶着。所以措辞刻意写得短、平、不喊"主人"，
// 免得不像是她在说话（踩过：一水儿的"主人～"，用户直接问"怎么又叫上主人了"）。
import type { Session } from "../core/session";
import { greetingByHour } from "../core/session";

export interface ReplyCtx {
  personaName: string;
  session: Session;
  memory?: string; // 回忆到的一句话
  todoStats?: string; // 待办摘要
  pomodoroText?: string; // 番茄钟状态
}

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const GENERIC = [
  "嗯，我在听。",
  "怎么了？",
  "说吧，我听着呢。",
  "我在。",
  "嗯？",
  "让我想想。",
];

/** 接不上大脑时的统一说明（比装作正常更诚实，也方便一眼看出问题） */
const OFFLINE_HINT = "（我脑子还没连上，这句是兜底的。）";

export function localReply(text: string, ctx: ReplyCtx): string {
  const name = ctx.personaName;
  const t = text.trim();

  if (/几点|现在时间|时间/.test(t)) {
    const d = new Date();
    return `现在${d.getHours()}点${d.getMinutes()}分${d.getHours() > 22 ? "，别熬太晚。" : "。"}`;
  }
  if (/几号|日期|礼拜|星期/.test(t)) {
    const d = new Date();
    const w = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    return `今天${d.getMonth() + 1}月${d.getDate()}日，星期${w}。`;
  }

  if (/^(你好|嗨|哈喽|hi|hello|在吗|在不在)/i.test(t)) {
    return `${greetingByHour(new Date().getHours())}。${OFFLINE_HINT}`;
  }
  if (/你叫什么|你的名字|你是谁|自我介绍|介绍一下自己/.test(t)) {
    return `我叫${name}。${OFFLINE_HINT}`;
  }

  if (/游戏|在玩什么|玩多久/.test(t) && ctx.session.activity.kind === "game") {
    return `你现在登记的活动是「${ctx.session.activity.label || "游戏"}」。`;
  }
  if (/游戏/.test(t) && ctx.session.activity.kind === "none") {
    return "在玩什么？";
  }

  if (/待办|todo|任务|作业|忘了|提醒/.test(t)) {
    if (ctx.todoStats) return ctx.todoStats;
    return "有哪些事没做完？说给我，我记着。";
  }
  if (/吃|饿|饭/.test(t)) return pick(["记得吃饭。", "饿了就去吃，别扛着。"]);
  if (/累|困|睡了|想睡|疲惫/.test(t)) return pick(["那去睡吧。", "累了就歇，别硬撑。"]);
  if (/谢谢|感谢|辛苦/.test(t)) return pick(["嗯。", "不用谢。"]);
  if (/再见|拜拜|晚安|先走了/.test(t)) return pick(["晚安。", "去吧。"]);

  if (ctx.memory) {
    const m = ctx.memory.slice(0, 40);
    return pick([`我记得：「${m}」。`, `这个我记着：「${m}」。`]);
  }
  if (ctx.pomodoroText) {
    return pick(["专注完了起来动动。", "到点了就歇会儿。"]);
  }
  return pick(GENERIC);
}

