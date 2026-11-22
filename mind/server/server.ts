// mind-server：她的大脑常驻服务（HTTP + SSE）
// 前端（桌宠/QQ/实体）只通过这里跟她说话 —— 前端不知道人格、不存记忆、不拼 prompt
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

import { loadConfig, patchConfig, type MindConfig } from "./lib/config.ts";
import { ensureDirs, dateStr, addDays, MIND_ROOT, P, CONFIG_PATH } from "./lib/paths.ts";
import {
  appendRaw, readRaw, rawDates, newMsgId, loadState, saveState, loadEpisodic, loadEmotional,
  loadQueue, readDigest, digestDates, recentDigests, listTrash, restoreFromTrash,
  forgetDate, forgetEpisode, updateEpisode, writeDigest, rebuildIndex, backupNow,
  loadHabits, appendHabits, updateHabit, forgetHabit, rebuildHabitIndex,
  type RawMsg,
} from "./lib/store.ts";
import { personaBase, personaSections, selfBlock, currentAge } from "./lib/persona.ts";
import { retrieve, explain, openThreadsText } from "./lib/retrieve.ts";
import { backfillVectors } from "./lib/vectors.ts";
import { generateProactive } from "./lib/proactive.ts";
import { screenDays } from "./lib/screenDay.ts";
import { buildReplyMessages } from "./lib/prompts.ts";
import { planAvatar } from './lib/avatar.ts';
import { avatarReplyContext, validAvatarAction, avatarMessages, avatarImage } from './lib/avatarProtocol.ts';
import { channelHistory, inConversation, recentDialogueOnly, type DialogueTurn, type AssistantOrigin } from "./lib/conversation.ts";
import { reviewDialogueReply } from "./lib/dialogueReview.ts";
import { singleParagraph } from './lib/replyStyle.ts';
import { polishSpokenReply } from './lib/replyPolish.ts';
import { parseChatImage, saveChatImage, withChatImages } from "./lib/attachments.ts";
import { chatStream, chatJson, chatVision } from "./lib/llm.ts";
import { webSearch, searchToText, isSearchRequest, looksLikeFreshQuestion, searchUsable } from "./lib/search.ts";
import { startScheduler, tick, isIdle } from "./lib/scheduler.ts";
import { summarizeDate } from "./lib/summarize.ts";
import {
  detectCorrection, correctionToHabit, matchHabits, injectText, formatHabit, previewHabitMatch,
} from "./lib/habits.ts";

const VERSION = "0.1.0-p1-avatar-control-monochrome-dialogue";
const cfg: MindConfig = loadConfig();
ensureDirs();

// ---------------- 会话历史（内存） ----------------
interface Session {
  id: string;
  channel: string;
  history: DialogueTurn[];
  lastSeen: number;
}
const sessions = new Map<string, Session>();
// Authenticated local renderer inspection, transient and separate from conversations.
const avatarRuntime = new Map<string, any>();
let avatarJob: any = null;
let avatarResult: any = null;
// 16 条太短：他上午说"我下楼吃饭了"，到中午那段话已被挤出窗口，
// 她再开口就变成又问一遍"吃没吃"。保留24小时内最近60条有效消息。
const HISTORY_MAX = 60;

type RecentMsg = { id: string; ts: number; role: string; text: string; channel?: string; imageId?: string; origin?: AssistantOrigin };

/**
 * 从原始记录里取最近几条，用于：① 会话建立时播种上下文 ② 前端恢复聊天窗口
 * @param since 只取这个时间戳（毫秒）之后的记录，用于"恢复一天以内的聊天"
 */
function recentRaw(limit = 20, channel?: string, since?: number): RecentMsg[] {
  const all = [...rawDates(), ...listTrash().map((t) => t.date)].sort();
  if (!all.length) return [];
  // 有时间下限时，只读覆盖到那一刻的那几天文件；日期不够就读最后一天兜底
  let dates = all;
  if (since && since > 0) {
    const from = dateStr(new Date(since));
    const picked = all.filter((d) => d >= from);
    dates = picked.length ? picked : all.slice(-1);
  }
  const out: RecentMsg[] = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    if (!since && out.length >= limit) break;
    const msgs = readRaw(dates[i]).filter((m) => (channel ? (m.channel ?? "pet") === channel : true));
    out.unshift(...msgs.map((m) => ({ id: m.id, ts: m.ts, role: m.role, text: m.text, channel: m.channel, ...(m.imageId ? { imageId: m.imageId } : {}), ...(m.origin ? { origin: m.origin } : {}) })));
  }
  const kept = since && since > 0 ? out.filter((m) => m.ts >= since) : out;
  return kept.slice(-limit);
}

/** 只保留能进聊天气泡的对话（丢掉 cli 之类没有气泡形态的内容） */
function chatTurns(items: RecentMsg[]): RecentMsg[] {
  return items.filter((m) => (m.role === "user" || m.role === "pet") && m.text.trim());
}

function getSession(id: string | undefined, channel = "pet"): Session {
  // 新会话：用最近 24 小时内的原始记录播种上下文 —— 这样她重启后仍然"记得刚才聊过什么"。
  // 必须限时间窗：以前只按条数取，今天话少时会翻到好几天前的旧记录当"正在聊的话"
  // （真实踩过：10-05 的对话里突然冒出 09-26 那句"deepseek怎么了"）。
  // Reload on EVERY request: main/mini may carry distinct session IDs, but
  // the persisted channel transcript is authoritative for both. Never seed
  // from a client's untrusted history, and never count blank failed replies.
  const seed = channelHistory(recentRaw(HISTORY_MAX * 2, channel, Date.now() - 24 * 3600_000), channel, Date.now(), HISTORY_MAX);
  if (id && sessions.get(id)?.channel === channel) {
    const s = sessions.get(id)!;
    s.history = seed;
    s.lastSeen = Date.now();
    return s;
  }
  const s: Session = { id: id || crypto.randomBytes(8).toString("hex"), channel, history: seed, lastSeen: Date.now() };
  sessions.set(s.id, s);
  return s;
}

// ---------------- HTTP 工具 ----------------
const ALLOWED_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|http:\/\/tauri\.localhost|tauri:\/\/localhost)$/i;

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGIN.test(origin)) return false; // 拒绝陌生网页（防其它网站戳本地服务）
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  return true;
}

function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += c.length;
    if (bytes > 12 * 1024 * 1024) throw Object.assign(new Error("请求过大，单图最多8MB"), { statusCode: 413 });
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function authed(req: http.IncomingMessage): boolean {
  const token = cfg.token;
  const h = req.headers.authorization || "";
  const got = h.replace(/^Bearer\s+/i, "").trim();
  if (!token) return true;
  return got === token;
}

// ---------------- 业务：一轮对话（SSE） ----------------
// 注意：body 由路由层统一读取后传入，这里不能再次 readBody（流只能读一次）
async function handleMessage(_req: http.IncomingMessage, res: http.ServerResponse, _url: URL, body: any): Promise<void> {
  let text = String(body.text ?? "").trim();
  let parsedImage: ReturnType<typeof parseChatImage>;
  try { parsedImage = parseChatImage(body.image); }
  catch (e) { sendJson(res, 400, { error: (e as Error).message }); return; }
  if (parsedImage && !text) text = "[图片]";
  const channel = String(body.channel ?? "pet");
  const session = getSession(body.session_id, channel);

  if (!text) {
    sendJson(res, 400, { error: "text 不能为空" });
    return;
  }

  // ① 落原始日志（零 LLM 成本，同步）
  const date = dateStr();
  const seq = readRaw(date).length + 1;
  const uploaded = parsedImage ? saveChatImage(parsedImage) : undefined;
  const userMsg: RawMsg = { id: newMsgId(date, seq), ts: Date.now(), role: "user", text, channel, activity: body.activity,
    ...(uploaded ? { imageId: uploaded.id } : {}) };
  appendRaw(date, userMsg);
  saveState({ lastActivityTs: Date.now() });

  // ①b 他当场纠正"你理解错了"→ 立刻入账哥哥的习惯（纯规则，毫秒级，不等日总结）
  //     数据来源就是这一步和日总结，见 lib/habits.ts 顶部说明。
  if (cfg.habits.enabled) {
    try {
      const hit = detectCorrection(text, session.history, channel);
      if (hit) {
        const h = correctionToHabit(hit, date);
        h.evidence = [userMsg.id];
        // 上一句她说错的话也留作证据，方便面板上回看"当时是怎么答错的"
        const prevPet = recentRaw(4, channel).filter((m) => m.role === "pet").slice(-1)[0];
        if (prevPet?.id && prevPet.id !== userMsg.id) h.evidence = [prevPet.id, userMsg.id];
        const r = appendHabits([h]);
        log(`habit(correct) 「${h.key}」= ${h.meaning}${r.added ? " 已入账" : " 已确认过"}（${hit.reasons.join("；")}）`);
      }
    } catch (e) {
      console.warn("[habits] 实时纠正入账失败（不影响这轮对话）：", (e as Error).message);
    }
  }

  // ② 检索记忆（关键词 + 本地嵌入语义召回 + 联想）+ 未完结事务
  const localDialogue = recentDialogueOnly(text, session.history.slice(-4));
  const r = localDialogue
    ? { items: [], text: "", ids: [], associations: [], assocText: "", mode: "recent-dialogue" }
    : await retrieve(text, cfg);
  // Open threads are useful for an actual planning/progress question, not a
  // license to interrupt every unrelated reply with old to-do questions.
  const threads = !localDialogue && /待办|计划|进度|进展|任务|安排|提醒|接下来|没做完|还没完成/.test(text) ? openThreadsText(3) : "";
  // ②b 哥哥的习惯：他这句话踩到了哪些"说法 → 真意"（同样零 LLM 成本）
  const hm = cfg.habits.enabled && !localDialogue
    ? matchHabits(text, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore })
    : [];
  const habitsText = injectText(hm, cfg);
  if (hm.length) log(`habit(match) ${hm.map((x) => `「${x.habit.key}」${x.score}`).join("、")}`);
  log(`retrieve "${text.slice(0, 20)}" → ${r.mode} ${r.ids.length} 条${r.associations.length ? ` +联想 ${r.associations.length}` : ""}${hm.length ? ` +习惯 ${hm.length}` : ""}`);

  // ③ 联网搜索：显式触发（"搜一下 xxx"）
  let searchText = "";
  const sr = isSearchRequest(text);
  if (sr.hit) {
    const q = sr.query || text;
    const out = await webSearch(q, cfg);
    log(`search(explicit) "${q}" → ${out.ok ? `${out.results.length} 条 ${out.ms}ms` : `失败：${out.error}`}`);
    if (!out.ok) {
      // 明确要求查却查不了 → 直说，不装作查过了
      const errText = "（搜不了：" + out.error + "）";
      const seq2 = readRaw(date).length + 1;
      appendRaw(date, { id: newMsgId(date, seq2), ts: Date.now(), role: "pet", text: errText, channel });
      const payload = { final: { text: errText, session_id: session.id, channel, memory_used: [] } };
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      res.write("data: " + JSON.stringify(payload) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    searchText = searchToText(out);
  }

  // ③b 自动判断：这句话像"需要外部/最新信息"的问题吗？像就给她一次要搜索的机会
  const autoTrying =
    !localDialogue && !sr.hit && cfg.search.auto && searchUsable(cfg) && looksLikeFreshQuestion(text);

    const screenDayText = channel === "pet" && !uploaded && (/今天|白天|今晚|上午|下午|刚才那个|那个画面/.test(text) ||
      session.history.slice(-4).some(h => h.role === "assistant" && h.origin?.kind === "screen-day"))
      ? (() => { try { const day = screenDays.load(); return day.reflection?.summary || day.summary; }
          catch { return ""; } })() : "";
    const buildMsgs = (extra: { searchText?: string; canAskSearch?: boolean }) =>
    withChatImages([...buildReplyMessages(cfg, {
      history: session.history.slice(-HISTORY_MAX),
      userText: text,
      imageId: uploaded?.id,
      memoryText: r.text,
        screenDayText,
      assocText: r.assocText,
      habitsText,
      threadsText: threads,
      searchText: extra.searchText ?? "",
      canAskSearch: extra.canAskSearch,
    }), ...avatarMessages(body.avatar)]);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let replyReady = false;
  const sse = (obj: unknown) => {
    if (!replyReady && obj && typeof obj === 'object' && 'delta' in obj) return;
    const event = obj && typeof obj === 'object' && 'delta' in obj
      ? { ...obj, delta: singleParagraph(String(obj.delta)) } : obj;
    return res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const reviewReply = localDialogue && !sr.hit;

  let full = "";
  let searched: { query: string; provider: string; count: number } | null = null;
  let usage: { model: string; ms: number } = { model: cfg.llm.model, ms: 0 };
  try {
    if (autoTrying) {
      // 第一遍：先缓冲（不推给前端），问她要不算要查
      const probe = await chatStream(cfg, buildMsgs({ canAskSearch: true }), () => {}, { recoverEmpty: true });
      const m = probe.text.match(/\[\[\s*(?:搜索|search)\s*[:：]\s*(.+?)\s*\]\]/i);
      if (m) {
        const q = m[1].trim();
        const out = await webSearch(q, cfg);
        log(`search(auto) "${q}" → ${out.ok ? `${out.results.length} 条 ${out.ms}ms` : `失败：${out.error}`}`);
        if (out.ok && out.results.length) {
          searched = { query: q, provider: out.provider, count: out.results.length };
          // 第二遍：带上结果重写，这次流式给她
          const u2 = await chatStream(cfg, buildMsgs({ searchText: searchToText(out) }), (acc) => {
            full = acc;
            sse({ delta: acc });
          }, { recoverEmpty: true });
          usage = u2.usage;
        } else {
          // 搜不到就当没这回事，用第一遍的回答（去掉可能的标记）
          full = probe.text.replace(/\[\[\s*(?:搜索|search)\s*[:：][^\]]*\]\]/gi, "").trim();
          sse({ delta: full });
        }
      } else {
        full = probe.text;
        sse({ delta: full });
      }
    } else {
      const u1 = await chatStream(cfg, buildMsgs({ searchText }), (acc) => {
        full = acc;
        if (!reviewReply) sse({ delta: acc });
      }, { recoverEmpty: true });
      usage = u1.usage;
    }

    if (reviewReply) {
      const reviewed = await reviewDialogueReply(cfg, session.history.slice(-HISTORY_MAX), text, full, uploaded?.id, avatarReplyContext(body.avatar), avatarImage(body.avatar?.image));
      full = reviewed.text.trim();
      usage = { model: reviewed.usage.model, ms: usage.ms + reviewed.usage.ms };
      sse({ delta: full });
    }
    full = await polishSpokenReply(cfg, text, full);
    if (!full.trim()) throw new Error("模型未返回正文，请重试");
    replyReady = true;
    sse({delta:full});

    // ④ 记录她的回复
    const seq2 = readRaw(date).length + 1;
    appendRaw(date, { id: newMsgId(date, seq2), ts: Date.now(), role: "pet", text: full, channel });

    session.history.push({ role: "user", content: text, ...(uploaded ? { imageId: uploaded.id } : {}) }, { role: "assistant", content: full });
    if (session.history.length > HISTORY_MAX * 2) session.history.splice(0, session.history.length - HISTORY_MAX * 2);

    const topEmotion = r.items.find((i) => i.emotion)?.emotion?.emotion ?? null;
    sse({
      final: {
        text: full,
        session_id: session.id,
        channel,
        emotion: topEmotion, // P1：用检索到的记忆情绪做语气参考（生理心理模块后续接管）
        memory_used: r.ids,
        habits_used: hm.map((x) => x.habit.key), // 这轮用到哪几条哥哥的习惯（面板/调试可见）
        searched,
        model: usage.model,
        ms: usage.ms,
        date,
        ...(uploaded ? { image_id: uploaded.id, image_received: true } : {}),
      },
    });
    sse("[DONE]");
  } catch (e) {
    sse({ error: (e as Error).message });
    sse("[DONE]");
  } finally {
    res.end();
  }
}

// ---------------- 文档（控制台可读写的白名单） ----------------
/**
 * 只有这里列出的文档能被控制台读写 —— 不接受任意路径，防止误改/越界。
 * 每次写入前都会自动备份到 data/backups/edits/。
 */
const EDITABLE: Record<string, { path: string; label: string; note?: string }> = {
  persona: {
    path: P.personaDoc,
    label: "人格文档（她是谁）",
    note: "保存后立即生效（注入内容会重新读取）。这份文档 LLM 永远不会改写。",
  },
  seed: {
    path: path.join(MIND_ROOT, "docs", "设定", "初始记忆.md"),
    label: "初始记忆（15 岁以前，小说体）",
    note: "你的原稿。分批导入器还没做，先存原文；导入时按章节切分抽取情景/情绪记忆。",
  },
  config: {
    path: CONFIG_PATH,
    label: "配置（config.json）",
    note: "保存后立即重载。改端口需要重启服务。",
  },
  episodic: {
    path: P.episodic,
    label: "情景记忆（episodic.jsonl，一行一条）",
    note: "手改有风险；改完点「重建索引」。日常建议用面板里的可视化编辑。",
  },
  emotional: {
    path: P.emotional,
    label: "情绪记忆（emotional.jsonl，一行一条）",
    note: "每条通过 episode_id 挂在情景记忆上。",
  },
  habits: {
    path: P.habits,
    label: "哥哥的习惯（habits.jsonl，情景记忆的分支）",
    note: "他的「说法 → 真意」账本。手改有风险；改完点「重建习惯索引」（面板的习惯页也能直接编辑）。",
  },
};

function listDocs() {
  return Object.entries(EDITABLE).map(([key, d]) => {
    let size = 0;
    let mtime = "";
    try {
      const st = fs.statSync(d.path);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {
      /* 不存在 */
    }
    return { key, label: d.label, note: d.note ?? "", exists: size > 0, sizeKB: Math.round(size / 1024), mtime };
  });
}

function backupEdited(key: string, file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const dir = path.join(P.backups, "edits");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(dir, `${key}-${stamp}${path.extname(file) || ".txt"}`);
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

// ---------------- 路由 ----------------
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: any) => Promise<void> | void;

const routes: Record<string, Handler> = {
  // 控制台页面（她的面板）
  "GET /": (_req, res) => serveAdmin(res),
  "GET /admin": (_req, res) => serveAdmin(res),

  "GET /v1/docs": (_req, res) => {
    sendJson(res, 200, { docs: listDocs(), root: MIND_ROOT });
  },

  "GET /v1/docs/read": (_req, res, url) => {
    const key = url.searchParams.get("key") ?? "";
    const d = EDITABLE[key];
    if (!d) {
      sendJson(res, 404, { error: `没有这个文档：${key}` });
      return;
    }
    let content = "";
    try {
      content = fs.readFileSync(d.path, "utf8");
    } catch {
      content = "";
    }
    sendJson(res, 200, { key, label: d.label, note: d.note ?? "", path: d.path, content });
  },

  "POST /v1/docs/write": async (_req, res, _url, body) => {
    const key = String(body.key ?? "");
    const d = EDITABLE[key];
    if (!d) {
      sendJson(res, 404, { ok: false, error: `没有这个文档：${key}` });
      return;
    }
    const content = typeof body.content === "string" ? body.content : "";
    if (key === "config") {
      try {
        JSON.parse(content);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `JSON 不合法，没有保存：${(e as Error).message}` });
        return;
      }
    }
    const backup = backupEdited(key, d.path);
    try {
      fs.mkdirSync(path.dirname(d.path), { recursive: true });
      fs.writeFileSync(d.path, content, "utf8");
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e as Error).message });
      return;
    }
    // 保存后按文档类型热重载
    if (key === "persona") personaSections(true);
    if (key === "config") {
      Object.assign(cfg, loadConfig(true));
    }
    log(`docs/write ${key} → ${content.length} 字${backup ? `（已备份 ${path.basename(backup)}）` : ""}`);
    sendJson(res, 200, { ok: true, bytes: content.length, backup: backup ? path.basename(backup) : null });
  },

  "POST /v1/backup": (_req, res) => {
    try {
      const dir = backupNow();
      sendJson(res, 200, { ok: true, dir });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e as Error).message });
    }
  },

  "POST /v1/memory/reindex": async (_req, res) => {
    const idx = rebuildIndex();
    // 顺带补齐向量（本地嵌入；模型不在就只做关键词索引，不报错）
    const v = await backfillVectors();
    sendJson(res, 200, {
      ok: true,
      tokens: Object.keys(idx.tokens).length,
      vectors: v,
    });
  },

  "GET /v1/health": (_req, res) => {
    const eps = loadEpisodic();
    const ems = loadEmotional();
    const st = loadState();
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      llm: { mode: cfg.llm.mode, model: cfg.llm.model, hasKey: !!cfg.llm.apiKey },
      memory: { episodes: eps.length, emotions: ems.length, digests: digestDates().length, habits: loadHabits().length },
      queue: loadQueue().dates,
      trash: listTrash(),
      idle: isIdle(cfg, st),
      persona: { name: cfg.persona.name, age: currentAge(cfg), sections: personaSections().length },
    });
  },

  "POST /v1/message": handleMessage,

  // 主动聊天（P2）：桌宠每隔一阵来问一次"现在该不该开口、说什么"。
  // 由她的大脑决定（话题池配比/由头/去重/限额都在那边），桌宠只负责显示。
  "POST /v1/screen-day/observation": (_req, res, _url, body) => {
    sendJson(res, 200, screenDays.record(body));
  },
  "GET /v1/screen-day": (_req, res) => {
    const day = screenDays.load();
    sendJson(res, 200, { date: day.date, summary: day.summary, reflection: day.reflection?.summary || "", count: day.observations.length, updatedAt: day.updatedAt });
  },
  "POST /v1/proactive/topic": async (_req, res, _url, body) => {
    const channel = body.channel ? String(body.channel) : "pet";
    const session = getSession(body.session_id ? String(body.session_id) : undefined, channel);
    const out = await generateProactive(
      {
        activity: body.activity ? String(body.activity) : undefined,
        activityMinutes: Number(body.activityMinutes) || undefined,
        todoOpen: Number(body.todoOpen) || undefined,
        todoFirst: body.todoFirst ? String(body.todoFirst) : undefined,
        pomodoro: body.pomodoro ? String(body.pomodoro) : undefined,
        idleMinutes: Number(body.idleMinutes) || undefined,
        reason: body.reason ? String(body.reason) : undefined,
        screen: typeof body.screen === "string" ? body.screen.slice(0, 1500) : undefined,
        screenCapturedAt: Number(body.screenCapturedAt) || undefined,
        screenKey: typeof body.screenKey === "string" ? body.screenKey.slice(0, 120) : undefined,
        // 原样交给事件校验；畸形/禁用 moment 不得悄悄降级为普通 screen。
        screenMoment: body.screenMoment,
        backgroundMedia: body.backgroundMedia,
        attentionMode: ["entertainment", "work", "idle", "normal"].includes(body.attentionMode) ? body.attentionMode : undefined,
        // 她要说的话必须接在刚才的对话后面
        history: String(body.reason||"").startsWith("routine-") ? chatTurns(recentRaw(32,channel,Date.now()-24*3600_000)).slice(-16).map(h=>({role:h.role==="user"?"user":"assistant",content:h.text,at:h.ts})) : session.history.slice(-16).map((h) => ({ role: h.role, content: h.content })),
      },
      cfg,
    );
    log(`proactive(${body.reason ?? "-"}) → ${out.skip ? `skip: ${out.reason}` : `${out.kind}: ${out.text}`}`);
    // 她主动开口说的这句也要进对话记录和会话上下文，
    // 否则重启后聊天窗口里没了，而且她自己也不记得说过什么
    if (!out.skip && out.text) {
      const said = String(out.text);
      const date = dateStr();
      const seq = readRaw(date).length + 1;
      // Persist only how OUR remark was initiated. No OCR, fact, subtitle,
      // screenshot, background title or client-provided origin is stored.
      const at = Date.now();
      const origin: AssistantOrigin = { kind: body.reason === "screen-day" || (body.reason==="routine-evening" && out.kind==="screen") ? "screen-day" : out.kind === "screen" && body.reason === "screen"
        ? body.backgroundMedia !== undefined ? "background-media" : "screen" : "initiative", at };
      appendRaw(date, {
        id: newMsgId(date, seq),
        ts: Date.now(),
        role: "pet",
        text: said,
        channel,
        origin,
      });
      session.history.push({ role: "assistant", content: said, origin });
      if (session.history.length > HISTORY_MAX * 2) {
        session.history.splice(0, session.history.length - HISTORY_MAX * 2);
      }
    }
    sendJson(res, 200, out);
  },

  "POST /v1/avatar/act": async (_req, res, _url, body) => {
    try { sendJson(res, 200, await planAvatar(cfg, body)); }
    catch { sendJson(res, 200, { available: false, seen: false, reason: '立绘观察或动作决定未完成' }); }
  },

  "GET /v1/avatar/runtime": (_req, res) => {
    sendJson(res,200,{windows:[...avatarRuntime.values()].filter(v=>Date.now()-v.at<10000),
      result:avatarResult && Date.now()-avatarResult.at<30000 ? avatarResult : null});
  },
  "POST /v1/avatar/runtime": (_req,res,_url,body) => {
    if (!['main','mini'].includes(body?.label)) { sendJson(res,400,{error:'invalid window'});return; }
    avatarRuntime.set(body.label,{...body,at:Date.now()});
    const job=body.visible && avatarJob?.expiresAt>Date.now() ? avatarJob : null;
    if(job) avatarJob=null;
    sendJson(res,200,{job});
  },
  "POST /v1/avatar/runtime/check": (_req,res,_url,body) => {
    if ((body?.action && !validAvatarAction(body.action)) || (body?.text && (typeof body.text!=='string'||body.text.length>500))
      || (body?.reply && (typeof body.reply!=='string'||body.reply.length>2500))) {
      sendJson(res,400,{error:'invalid avatar check'});return;
    }
    avatarJob={id:crypto.randomUUID(),expiresAt:Date.now()+15000,action:body?.action,text:body?.text,reply:body?.reply};
    sendJson(res,200,{id:avatarJob.id});
  },
  "POST /v1/avatar/runtime/result": (_req,res,_url,body) => {
    avatarResult={...body,at:Date.now()};sendJson(res,200,{ok:true});
  },

  // 看图：桌宠截一帧发过来，用同一个 LLM key 让视觉模型说一句"画面里是什么"。
  // 图片只在这一次请求里用，不落盘、不进记忆。
  "POST /v1/vision": async (_req, res, _url, body) => {
    const image = String(body.image ?? "").replace(/^data:image\/[a-z]+;base64,/, "");
    if (!image) { sendJson(res, 400, { error: "image 不能为空" }); return; }
    const question = body.question
      ? String(body.question)
      : "这是哥哥电脑屏幕的画面。用一两句话说说你看到他在做什么、屏幕上是些什么。不要逐字念屏幕上的字，不要提“截图”两个字，就像你自己坐在旁边看到的一样。";
    try {
      const out = await chatVision(cfg, image, question, { model: body.model ? String(body.model) : undefined });
      log(`vision → ${out.text.slice(0, 60)}（${out.ms}ms）`);
      sendJson(res, 200, { text: out.text, model: out.model, ms: out.ms });
    } catch (e) {
      log(`vision 失败：${e instanceof Error ? e.message : String(e)}`);
      sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  },

  // 对话记录（前端启动时恢复聊天窗口 / 面板翻历史）
  // ?hours=24 只取最近一天的对话，用于桌宠重启后把聊天窗口恢复成原样
  "GET /v1/messages/recent": (_req, res, url) => {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const channel = url.searchParams.get("channel") ?? undefined;
    const hours = Number(url.searchParams.get("hours") ?? 0);
    const since = hours > 0 ? Date.now() - hours * 3600_000 : undefined;
    const items = chatTurns(recentRaw(limit, channel ?? undefined, since));
    sendJson(res, 200, { count: items.length, hours: hours > 0 ? hours : null, items });
  },
  "GET /v1/messages/dates": (_req, res) => {
    const raw = rawDates();
    const trash = listTrash().map((t) => t.date);
    sendJson(res, 200, { raw, trash, all: Array.from(new Set([...raw, ...trash])).sort().reverse() });
  },
  "GET /v1/messages": (_req, res, url) => {
    const date = url.searchParams.get("date") ?? dateStr();
    const limit = Number(url.searchParams.get("limit") ?? 300);
    const msgs = readRaw(date);
    sendJson(res, 200, {
      date,
      count: msgs.length,
      inTrash: !msgs.length && listTrash().some((t) => t.date === date),
      items: msgs.slice(-limit),
    });
  },

  "GET /v1/state": (_req, res) => {
    const st = loadState();
    sendJson(res, 200, {
      ...st,
      now: Date.now(),
      idle: isIdle(cfg, st),
      open_threads: openThreadsText(3),
    });
  },

  "GET /v1/persona": (_req, res) => {
    sendJson(res, 200, {
      base: personaBase(true),
      sections: personaSections(true).map((s) => ({ no: s.no, title: s.title, chars: s.body.length })),
      self: selfBlock(cfg),
      age: currentAge(cfg),
      doc: "mind/docs/设定/林阅心.md",
    });
  },
  "POST /v1/persona/reload": (_req, res) => {
    sendJson(res, 200, { ok: true, sections: personaSections(true).length, base: personaBase(true).length });
  },

  "GET /v1/memory/search": async (_req, res, url) => {
    const q = url.searchParams.get("q") ?? "";
    const k = Number(url.searchParams.get("k") ?? cfg.retrieve.topK);
    const r = await retrieve(q, { ...cfg, retrieve: { ...cfg.retrieve, topK: k } });
    // 顺手给出"这句话会踩到哪些哥哥的习惯"——检索测试页一眼能看出判断依据从哪来
    const hm = cfg.habits.enabled
      ? matchHabits(q, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore })
      : [];
    sendJson(res, 200, {
      query: q,
      mode: r.mode,
      text: r.text,
      assocText: r.assocText,
      habitsText: injectText(hm, cfg),
      habits: hm.map((x) => ({
        id: x.habit.id,
        key: x.habit.key,
        meaning: x.habit.meaning,
        misunderstood: x.habit.misunderstood ?? null,
        score: x.score,
        reasons: x.reasons,
        confidence: x.habit.confidence,
      })),
      associations: r.associations.map((a) => ({
        id: a.episode.id,
        date: a.episode.date,
        title: a.episode.title,
        kind: a.kind,
        similarity: a.similarity == null ? null : Math.round(a.similarity * 100) / 100,
        why: a.why,
      })),
      items: r.items.map((i) => ({
        id: i.episode.id,
        date: i.episode.date,
        title: i.episode.title,
        summary: i.episode.summary,
        salience: i.episode.salience,
        emotion: i.emotion?.emotion ?? null,
        valence: i.emotion?.valence ?? null,
        score: Math.round(i.score * 100) / 100,
        reasons: i.reasons,
        evidence: i.episode.evidence,
      })),
      why: url.searchParams.get("explain") ? await explain(q, cfg) : undefined,
    });
  },

  "GET /v1/memory/list": (_req, res, url) => {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const ems = loadEmotional();
    const emoByEp = new Map(ems.map((m) => [m.episode_id, m]));
    const eps = loadEpisodic()
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, limit)
      .map((e) => ({ ...e, emotion: emoByEp.get(e.id) ?? null }));
    sendJson(res, 200, { count: eps.length, items: eps });
  },

  "GET /v1/memory/diary": (_req, res, url) => {
    const date = url.searchParams.get("date") ?? dateStr();
    const d = readDigest(date);
    sendJson(res, 200, { date, digest: d, raw: rawForPanel(date) });
  },

  "GET /v1/memory/diaries": (_req, res, url) => {
    const n = Number(url.searchParams.get("n") ?? 30);
    sendJson(res, 200, {
      dates: digestDates().slice(-n).reverse(),
      items: recentDigests(n).map((d) => ({
        date: d.date,
        diary: d.diary,
        episodes: d.episodes.length,
        emotions: d.emotions.length,
        edited_by: d.edited_by ?? null,
        stats: d.stats,
      })),
    });
  },

  "POST /v1/memory/edit": async (_req, res, _url, body) => {
    if (body.episodeId) {
      const r = updateEpisode(String(body.episodeId), body.patch ?? {});
      sendJson(res, r ? 200 : 404, { ok: !!r, episode: r });
      return;
    }
    if (body.date && typeof body.diary === "string") {
      const d = readDigest(String(body.date));
      if (!d) {
        sendJson(res, 404, { ok: false, error: "这天还没有档案卡" });
        return;
      }
      writeDigest({ ...d, diary: String(body.diary).slice(0, 4000), edited_by: "user" });
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 400, { ok: false, error: "需要 episodeId+patch 或 date+diary" });
  },

  "POST /v1/memory/forget": async (_req, res, _url, body) => {
    if (Array.isArray(body.ids) && body.ids.length) {
      let n = 0;
      for (const id of body.ids) if (forgetEpisode(String(id))) n++;
      sendJson(res, 200, { ok: true, removed: n });
      return;
    }
    if (body.date) {
      const r = forgetDate(String(body.date));
      sendJson(res, 200, { ok: true, ...r });
      return;
    }
    sendJson(res, 400, { ok: false, error: "需要 ids 或 date" });
  },

  // ---------------- 哥哥的习惯（情景记忆的分支） ----------------
  // 他的"说法 → 真意"账本。写入有两条自动路径（实时纠正 / 日总结抽取），
  // 这里只提供人在面板上的看、改、删，以及"试一句"看会不会命中。
  "GET /v1/habits": (_req, res, url) => {
    const q = (url.searchParams.get("q") ?? "").trim();
    const all = loadHabits().sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
    const items = q
      ? all.filter((h) =>
          [h.key, h.meaning, h.misunderstood ?? "", h.tone ?? "", ...(h.tags ?? [])].join(" ").includes(q))
      : all;
    sendJson(res, 200, {
      count: items.length,
      total: all.length,
      items: items.map((h) => ({ ...h, preview: formatHabit(h) })),
      enabled: cfg.habits.enabled,
      extract: cfg.habits.extract,
    });
  },

  "POST /v1/habits/edit": (_req, res, _url, body) => {
    const id = String(body.id ?? "");
    const patch = body.patch ?? {};
    const h = updateHabit(id, patch);
    sendJson(res, h ? 200 : 404, { ok: !!h, habit: h });
  },

  "POST /v1/habits/forget": (_req, res, _url, body) => {
    const ok = forgetHabit(String(body.id ?? ""));
    sendJson(res, ok ? 200 : 404, { ok });
  },

  "POST /v1/habits/rebuild": (_req, res) => {
    const idx = rebuildHabitIndex();
    sendJson(res, 200, { ok: true, tokens: Object.keys(idx.tokens).length });
  },

  // 试一句：这句话会踩到哪几条习惯、注入文本长什么样（不调 LLM）
  "GET /v1/habits/try": (_req, res, url) => {
    const q = url.searchParams.get("q") ?? "";
    const p = previewHabitMatch(q, cfg);
    sendJson(res, 200, { query: q, ...p });
  },

  // 手动填一条（面板上补录；也方便从初始记忆里整理）
  "POST /v1/habits/add": (_req, res, _url, body) => {
    const key = String(body.key ?? "").trim();
    const meaning = String(body.meaning ?? "").trim();
    if (key.length < 2 || !meaning) {
      sendJson(res, 400, { ok: false, error: "需要 key（≥2 字）和 meaning" });
      return;
    }
    const today = dateStr();
    const r = appendHabits([{
      id: `hb_${today.replace(/-/g, "")}_${crypto.randomBytes(2).toString("hex")}`,
      key: key.slice(0, 24),
      meaning: meaning.slice(0, 80),
      misunderstood: body.misunderstood ? String(body.misunderstood).slice(0, 40) : undefined,
      tone: body.tone ? String(body.tone).slice(0, 8) : undefined,
      behavior: body.behavior ? String(body.behavior).slice(0, 60) : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 6) : ["手工"],
      confidence: Number(body.confidence) || 0.6,
      confirmations: 1,
      evidence: [],
      source: "import",
      first_seen: today,
      last_seen: today,
      created_at: new Date().toISOString(),
      edited_by: "user",
    }]);
    sendJson(res, 200, { ok: true, ...r });
  },

  "GET /v1/memory/trash": (_req, res) => {
    sendJson(res, 200, { items: listTrash(), keepDays: cfg.trashDays });
  },
  "POST /v1/memory/restore": async (_req, res, _url, body) => {
    const ok = restoreFromTrash(String(body.date ?? ""));
    sendJson(res, ok ? 200 : 404, { ok });
  },

  // 联网搜索（面板测试用）
  "GET /v1/search": async (_req, res, url) => {
    const q = url.searchParams.get("q") ?? "";
    const out = await webSearch(q, cfg);
    log(`/v1/search "${q}" → ${out.ok ? out.results.length + " 条" : out.error}`);
    sendJson(res, out.ok ? 200 : 400, { ...out, text: searchToText(out) });
  },

  // 测试 LLM 连接（面板"测试连接"按钮）
  "POST /v1/llm/test": async (_req, res, _url, body) => {
    const t0 = Date.now();
    try {
      const { text, usage } = await chatStream(
        cfg,
        [
          { role: "system", content: "只回四个字：连接正常" },
          { role: "user", content: String(body.prompt ?? "在吗") },
        ],
        () => {},
      );
      sendJson(res, 200, { ok: true, reply: text.slice(0, 80), model: usage.model, ms: Date.now() - t0 });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: (e as Error).message, ms: Date.now() - t0 });
    }
  },

  "POST /v1/job/run": async (_req, res, _url, body) => {
    const job = String(body.job ?? "tick");
    if (job === "summarize") {
      const date = String(body.date ?? addDays(dateStr(), -1));
      const r = await summarizeDate(date, cfg, !!body.force);
      sendJson(res, 200, { ok: r.ok, outcome: r });
      return;
    }
    const r = await tick(cfg, { manual: true });
    sendJson(res, 200, { ok: true, tick: r });
  },

  "POST /v1/llm/key": async (_req, res, _url, body) => {
    const apiKey = String(body.apiKey ?? "").trim();
    if (!apiKey) {
      sendJson(res, 400, { ok: false, error: "apiKey 为空" });
      return;
    }
    patchConfig({
      llm: {
        mode: "deepseek",
        apiKey,
        ...(body.baseUrl ? { baseUrl: String(body.baseUrl) } : {}),
        ...(body.model ? { model: String(body.model), summaryModel: String(body.model) } : {}),
      },
    });
    Object.assign(cfg, loadConfig(true));
    saveState({ keyHandoverAt: Date.now() });
    sendJson(res, 200, { ok: true, llm: { mode: cfg.llm.mode, model: cfg.llm.model, hasKey: true } });
  },

  "GET /v1/config": (_req, res) => {
    const { llm, search, ...safe } = cfg;
    sendJson(res, 200, {
      ...safe,
      // Key 只回"有没有配"，不回明文（面板用写覆盖）
      llm: { ...llm, apiKey: "", apiKeySet: !!llm.apiKey },
      search: { ...search, apiKey: "", apiKeySet: !!search.apiKey },
    });
  },
  "POST /v1/config": async (_req, res, _url, body) => {
    const patch = { ...(body ?? {}) };
    // 防止面板把已配好的 Key 清空：空字符串或掩码一律视为"不改动"
    for (const sec of ["llm", "search"] as const) {
      const k = patch[sec]?.apiKey;
      if (k === undefined) continue;
      if (k === "" || k === "***" || k === "***已配置***") delete patch[sec].apiKey;
    }
    patchConfig(patch);
    Object.assign(cfg, loadConfig(true));
    log(`config patched: ${Object.keys(patch).join(",")}`);
    sendJson(res, 200, { ok: true, llm: { model: cfg.llm.model, apiKeySet: !!cfg.llm.apiKey }, search: { provider: cfg.search.provider, apiKeySet: !!cfg.search.apiKey } });
  },
};

function rawForPanel(date: string): { count: number; items: { id: string; ts: number; role: string; text: string }[] } {
  const raw = readRaw(date);
  return { count: raw.length, items: raw.slice(-200) };
}

// ---------------- 启动 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const t0 = Date.now();

  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: "origin 不允许（只允许本机/tauri 前端）" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  // 控制台页面与健康检查免 token（页面自身内嵌了 token 用于调接口）
  const OPEN_PATHS = new Set(["/", "/admin", "/v1/health"]);
  if (!OPEN_PATHS.has(url.pathname) && !authed(req)) {
    log(`${req.method} ${url.pathname} → 401 token 无效（来源 ${req.headers.origin ?? "-"}）`);
    sendJson(res, 401, { error: "token 无效" });
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    log(`${key} → 404`);
    sendJson(res, 404, { error: `未知接口 ${key}` });
    return;
  }
  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (key === "POST /v1/message" || key === "POST /v1/proactive/topic") {
        await inConversation(String(body.channel || "pet"), async () => handler(req, res, url, body));
    } else {
      await handler(req, res, url, body);
    }
    if (url.pathname !== "/v1/message" && url.pathname !== '/v1/avatar/runtime') log(`${key} → ${res.statusCode} ${Date.now() - t0}ms`);
  } catch (e) {
    const statusCode = (e as any).statusCode === 413 ? 413 : 500;
    log(`${key} → ${statusCode} ${(e as Error).message}`);
    console.error(`[mind] ${key} 出错：`, e);
    if (!res.headersSent) sendJson(res, statusCode, { error: (e as Error).message });
    else res.end();
  }
});

/** 输出控制台页面（把 token 注入进去，页面才能调接口） */
function serveAdmin(res: http.ServerResponse): void {
  try {
    const file = path.join(MIND_ROOT, "server", "admin.html");
    let html = fs.readFileSync(file, "utf8");
    html = html.replace("__MIND_TOKEN__", cfg.token).replace("__MIND_VERSION__", VERSION);
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
    res.end(buf);
  } catch (e) {
    sendJson(res, 500, { error: `控制台页面读取失败：${(e as Error).message}` });
  }
}

/** 同时打到控制台与 data/server.log（排查"桌宠连上没有"最有用） */
function log(line: string): void {
  const s = `[${new Date().toLocaleString("zh-CN")}] ${line}`;
  console.log("[mind] " + line);
  try {
    fs.appendFileSync(path.join(MIND_ROOT, "data", "server.log"), s + "\n", "utf8");
  } catch {
    /* 日志失败不影响服务 */
  }
}

server.listen(cfg.port, cfg.host, () => {
  console.log(`[mind] 她在听：http://${cfg.host}:${cfg.port}  (v${VERSION}, LLM=${cfg.llm.mode}${cfg.llm.apiKey ? "" : " ⚠️无Key"})`);
  console.log(`[mind] 数据目录：mind/data  |  token: ${cfg.token.slice(0, 8)}…（完整值在 mind/config.json）`);
  writeHandshake();
  startScheduler(cfg, (r) => {
    if (r.summary) console.log(`[mind/scheduler] ${r.note}（${r.summary.ms ?? 0}ms）`);
  });
});

/**
 * 握手文件：把 url + token 写到桌宠的外置目录（app/mind.json），
 * 桌宠启动时读它自动连上，不必手动复制 token。
 */
function writeHandshake(): void {
  const json = JSON.stringify(
    { url: `http://${cfg.host}:${cfg.port}`, token: cfg.token, version: VERSION, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  const targets = [
    process.env.MIND_HANDSHAKE,
    path.resolve(MIND_ROOT, "../pet/release/app/mind.json"), // 发布版（启动器会提供它）
    path.resolve(MIND_ROOT, "../pet/public/mind.json"), // dev 模式（Vite 提供它）
  ].filter(Boolean) as string[];

  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, json, "utf8");
      console.log(`[mind] 握手文件已写入：${file}`);
    } catch (e) {
      console.warn(`[mind] 握手文件写入失败 ${file}：${(e as Error).message}`);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("[mind] 收工，保存状态…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
