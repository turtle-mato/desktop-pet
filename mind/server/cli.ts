// mind CLI：不依赖桌宠就能验收整套记忆流程
// 用法：node mind/server/cli.ts <命令> [参数]
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.ts";
import { ensureDirs, dateStr, addDays, rawPath, MIND_ROOT } from "./lib/paths.ts";
import {
  appendRaw, readRaw, newMsgId, loadEpisodic, loadEmotional, digestDates, readDigest,
  loadQueue, refillQueueFromRaw, listTrash, loadState, rebuildIndex,
  loadHabits, appendHabits, forgetHabit, rebuildHabitIndex, type Habit,
} from "./lib/store.ts";
import { summarizeDate, preprocess } from "./lib/summarize.ts";
import { tick, isIdle } from "./lib/scheduler.ts";
import { chatStream } from "./lib/llm.ts";
import { retrieve, explain, openThreadsText } from "./lib/retrieve.ts";
import { buildReplyMessages } from "./lib/prompts.ts";
import { searchUsable, looksLikeFreshQuestion } from "./lib/search.ts";
import { validateDigest } from "./lib/validate.ts";
import { personaBase, personaSections, selfBlock, currentAge } from "./lib/persona.ts";
import {
  detectCorrection, correctionToHabit, matchHabits, injectText, formatHabit,
} from "./lib/habits.ts";

const cfg = loadConfig();
ensureDirs();
const [cmd, ...args] = process.argv.slice(2);

const base = `http://${cfg.host}:${cfg.port}`;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { headers: H, ...init });
  const txt = await res.text();
  try {
    return { status: res.status, data: JSON.parse(txt) };
  } catch {
    return { status: res.status, data: txt };
  }
}

function print(x: unknown) {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

/** 造一天假对话，用于离线测试流水线 */
function mockDay(date: string) {
  const t0 = new Date(`${date}T20:30:00`).getTime();
  const lines: [RawMsgRole, string][] = [
    ["user", "今天面试了，感觉发挥一般"],
    ["pet", "啊？哪家公司呀，紧张吗"],
    ["user", "就之前跟你说的那家做游戏的，笔试过了，面试聊得不太好"],
    ["pet", "别急，面试这东西很看缘分的。你觉得哪里没答好"],
    ["user", "项目那块被追问得很细，我有点慌"],
    ["pet", "那你回来有复盘吗？下次就能答顺了"],
    ["user", "嗯…不想动了，今天好累"],
    ["pet", "那就先歇着，明天我陪你一起梳理"],
    ["user", "好。对了面试结果说三天内出"],
    ["pet", "那我记着了，出来记得告诉我"],
  ];
  const msgs = lines.map(([role, text], i) => ({
    id: newMsgId(date, i + 1),
    ts: t0 + i * 90_000,
    role: role as "user" | "pet",
    text,
    channel: "cli-test",
  }));
  fs.mkdirSync(path.dirname(rawPath(date)), { recursive: true });
  fs.writeFileSync(rawPath(date), msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  console.log(`已写入 ${msgs.length} 条假对话 → ${rawPath(date)}`);
}
type RawMsgRole = "user" | "pet" | "sys";

switch (cmd) {
  case "health": {
    const r = await api("/v1/health");
    print(r.data);
    break;
  }

  case "say": {
    const text = args.join(" ") || "在吗";
    const res = await fetch(`${base}/v1/message`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text, channel: "cli" }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      print(`HTTP ${res.status} ${t.slice(0, 200)}  （发送的 text=${JSON.stringify(text)}）`);
      break;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let last = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data:")) continue;
        const payload = chunk.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.delta) {
            last = j.delta;
            process.stdout.write(`\r她：${last.slice(-60).padEnd(60)}`);
          }
          if (j.final) {
            console.log("\n---");
            print({ emotion: j.final.emotion, memory_used: j.final.memory_used, ms: j.final.ms, model: j.final.model });
          }
          if (j.error) console.log("\n[错误]", j.error);
        } catch {
          /* 半行 */
        }
      }
    }
    console.log();
    break;
  }

  case "search": {
    const q = args.join(" ");
    const r = await retrieve(q, cfg);
    console.log(`查询：${q}\n命中 ${r.items.length} 条（方式：${r.mode}）`);
    for (const i of r.items) {
      console.log(`  · [${i.episode.date}] ${i.episode.title}  RRF=${i.score.toFixed(3)}  ${i.emotion ? `情绪=${i.emotion.emotion}` : ""}`);
      console.log(`      ${i.episode.summary}`);
      console.log(`      命中原因：${i.reasons.join("；") || "（无）"}`);
    }
    if (r.associations.length) {
      console.log(`\n联想 ${r.associations.length} 条：`);
      for (const a of r.associations) {
        console.log(`  ~ [${a.episode.date}] ${a.episode.title}（${a.kind}${a.similarity ? ` ${a.similarity.toFixed(2)}` : ""}）${a.why}`);
      }
    }
    console.log("\n--- 注入文本 ---\n" + (r.text || "（无）"));
    if (r.assocText) console.log("\n--- 联想段 ---\n" + r.assocText);
    break;
  }
  case "why": {
    print(await explain(args.join(" "), cfg));
    break;
  }

  case "diary": {
    const date = args[0] ?? dateStr();
    const d = readDigest(date);
    if (!d) {
      console.log(`${date} 还没有档案卡`);
      break;
    }
    console.log(`===== ${date} 的日记（${d.model}，${d.edited_by === "user" ? "主人改过" : "自动"}）=====`);
    console.log(d.diary);
    console.log(`\n情景 ${d.episodes.length} 条 / 情绪 ${d.emotions.length} 条 / 未完结 ${d.open_threads.length} 条`);
    for (const e of d.episodes) {
      const em = d.emotions.find((m) => m.episode_id === e.id);
      console.log(`  · ${e.title}（拟人价值 ${e.salience}）${em ? ` 情绪：${em.emotion} v=${em.valence}` : ""}`);
      console.log(`    ${e.summary}`);
      if (e.review) console.log(`    复盘：${e.review}`);
      console.log(`    证据：${e.evidence.join(", ")}`);
    }
    if (d.dropped?.length) {
      console.log(`\n被证据校验丢弃 ${d.dropped.length} 条：`);
      for (const x of d.dropped) console.log(`  ✗ [${x.reason}] ${x.detail.slice(0, 100)}`);
    }
    if (d.open_threads.length) {
      console.log("\n未完结：");
      for (const t of d.open_threads) console.log(`  · ${t.text}（${t.since} 起）`);
    }
    break;
  }

  case "list": {
    const eps = loadEpisodic();
    const ems = loadEmotional();
    console.log(`情景记忆 ${eps.length} 条 / 情绪记忆 ${ems.length} 条 / 档案卡 ${digestDates().length} 天`);
    for (const e of eps.slice(-15)) {
      const em = ems.find((m) => m.episode_id === e.id);
      console.log(`  · [${e.date}] ${e.title}${em ? ` —— ${em.emotion}` : ""}`);
    }
    break;
  }

  case "summarize": {
    const date = args[0] ?? (refillQueueFromRaw(), loadQueue().dates[0]) ?? addDays(dateStr(), -1);
    console.log(`开始总结 ${date} …`);
    const r = await summarizeDate(date, cfg, args.includes("--force"));
    console.log(`结果：ok=${r.ok} ${r.note}${r.ms ? `（${r.ms}ms）` : ""}`);
    if (r.digest) {
      console.log("\n日记：" + r.digest.diary.slice(0, 200));
      console.log(`情景 ${r.digest.episodes.length} / 情绪 ${r.digest.emotions.length}`);
    }
    break;
  }

  case "tick": {
    const r = await tick(cfg, { manual: args.includes("--force") });
    print(r);
    break;
  }

  case "state": {
    const st = loadState();
    print({ ...st, idle: isIdle(cfg, st), queue: loadQueue(), trash: listTrash(), today: dateStr() });
    break;
  }

  case "persona": {
    console.log(`年龄：${currentAge(cfg)}  ${selfBlock(cfg)}`);
    console.log(`段落：${personaSections(true).map((s) => `${s.no}.${s.title}`).join(" | ")}`);
    console.log("\n--- 注入的人格基础层（前 600 字）---\n" + personaBase(true).slice(0, 600));
    break;
  }

  case "mock-day": {
    mockDay(args[0] ?? addDays(dateStr(), -1));
    break;
  }

  case "reindex": {
    const idx = rebuildIndex();
    console.log(`索引重建完成：${Object.keys(idx.tokens).length} 个 token`);
    break;
  }

  case "handover-key": {
    const key = args[0] ?? "";
    const r = await api("/v1/llm/key", { method: "POST", body: JSON.stringify({ apiKey: key }) });
    print(r.data);
    break;
  }

  case "prompt": {
    // 把"实际发给模型的一字一句"原样打出来（完全透明，方便抓提示词问题）
    const text = args.join(" ") || "没看出来像在哪";
    const r = await retrieve(text, cfg);
    const threads = openThreadsText(3);
    const date = dateStr();
    const raw = readRaw(date).slice(-8).filter((m) => m.role === "user" || m.role === "pet");
    const msgs = buildReplyMessages(cfg, {
      history: raw.map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.text,
      })),
      userText: text,
      memoryText: r.text,
      assocText: r.assocText,
      habitsText: injectText(matchHabits(text, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore }), cfg),
      threadsText: threads,
      canAskSearch: searchUsable(cfg) && looksLikeFreshQuestion(text),
    });
    console.log("════ 实际发给模型的内容（没有别的东西了） ════");
    msgs.forEach((m, i) => {
      console.log(`\n───── [${i}] role=${m.role}  (${m.content.length} 字) ─────`);
      console.log(m.content);
    });
    console.log("\n════ 结束 ════");
    break;
  }

  case "try": {
    // 用"当前文件里的提示词"在本机直接生成一次回复（不经过运行中的服务，改完提示词立刻能试）
    const text = args.join(" ") || "没看出来像在哪";
    const r = await retrieve(text, cfg);
    const threads = openThreadsText(3);
    const date = dateStr();
    const raw = readRaw(date).slice(-8).filter((m) => m.role === "user" || m.role === "pet");
    const msgs = buildReplyMessages(cfg, {
      history: raw.map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.text,
      })),
      userText: text,
      memoryText: r.text,
      assocText: r.assocText,
      habitsText: injectText(matchHabits(text, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore }), cfg),
      threadsText: threads,
      canAskSearch: false,
    });
    const out = await chatStream(cfg, msgs, () => {});
    console.log("你：" + text);
    console.log("她：" + out.text.trim());
    console.log(`（${out.usage.model}，${out.usage.ms}ms）`);
    break;
  }

  case "test": {
    // 证据校验自测：LLM 编造的事件必须被丢弃
    const date = args[0] ?? dateStr();
    const draft = {
      diary: "测试日记",
      episodes: [
        { title: "真实事件", summary: "有真实证据", salience: 0.6, evidence: ["m_real_0001"] },
        { title: "编造事件", summary: "引用不存在的 id", salience: 0.9, evidence: ["m_fake_9999"] },
        { title: "混合证据", summary: "一半真一半假", salience: 0.5, evidence: ["m_real_0001", "m_fake_9999"] },
      ],
      emotions: [{ episode_title: "真实事件", emotion: "开心", valence: 0.8, intensity: 0.7, evidence: ["m_real_0001"] }],
      open_threads: [{ text: "测试未完结", since: date }],
    };
    const valid = new Set(["m_real_0001"]);
    const v = validateDigest(draft, valid, date, new Date().toISOString());
    const pass =
      v.episodes.length === 2 &&
      v.episodes.every((e) => e.evidence.every((id) => valid.has(id))) &&
      v.dropped.length === 1 &&
      v.dropped[0].detail.includes("编造事件");
    console.log(`情景保留 ${v.episodes.length} 条、丢弃 ${v.dropped.length} 条`);
    for (const d of v.dropped) console.log(`  ✗ [${d.reason}] ${d.detail}`);
    console.log(`情绪 ${v.emotions.length} 条（词表规范化：${v.emotions.map((e) => e.emotion).join(",")}）`);
    console.log(pass ? "✅ 证据校验通过：编造的事件被丢弃、混合证据只保留真实 id" : "❌ 证据校验未达预期");
    process.exitCode = pass ? 0 : 1;
    break;
  }

  case "vectors": {
    // 补齐/刷新所有情景的向量（本地嵌入，离线）。换模型、导入初始记忆后跑一次
    const { embedAvailable } = await import("./lib/embed.ts");
    const { backfillVectors } = await import("./lib/vectors.ts");
    const { loadVectors } = await import("./lib/store.ts");
    if (!embedAvailable()) {
      console.log("× 本地嵌入不可用：检查 mind/models/bge-small-zh-v1.5 与 mind/vendor 是否都在");
      process.exitCode = 1;
      break;
    }
    const r = await backfillVectors();
    console.log(`情景 ${r.total} 条，本次生成 ${r.embedded} 条向量，失败 ${r.failed} 条`);
    console.log(`当前共有向量 ${loadVectors().length} 条 → ${path.join(MIND_ROOT, "data", "vectors.jsonl")}`);
    break;
  }

  case "proactive": {
    // 试一次"主动开口"：看话题池怎么决定、她怎么说（真调一次 LLM：不思考 + 短输出，成本很小）
    const { generateProactive } = await import("./lib/proactive.ts");
    const out = await generateProactive(
      {
        reason: args[0] || "idle",
        idleMinutes: 35,
        activity: "工作",
        activityMinutes: 90,
        todoOpen: 3,
        todoFirst: "数电作业",
      },
      cfg,
    );
    if (out.skip) console.log(`× 这次不开口：${out.reason}`);
    else {
      console.log(`✓ [${out.kind}] ${out.text}`);
      console.log(`  （材料：${out.material}）`);
    }
    break;
  }

  case "habit": {
    // 哥哥的习惯账本：看 / 补 / 删，以及"这句话会踩到哪几条"（前两种不发 LLM）
    const sub = args[0] ?? "list";
    if (sub === "list" || sub === "ls") {
      const rows = loadHabits().sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
      console.log(`哥哥的习惯 ${rows.length} 条（${path.join(MIND_ROOT, "data", "episodic", "habits.jsonl")}）`);
      for (const h of rows) {
        console.log(`  · 「${h.key}」= ${h.meaning}`);
        console.log(`      语气=${h.tone ?? "-"} 确认=${h.confirmations} 可信=${h.confidence} 来源=${h.source} 最近=${h.last_seen}`);
        if (h.misunderstood) console.log(`      以前理解成：${h.misunderstood}`);
        if (h.behavior) console.log(`      下次这么接：${h.behavior}`);
      }
      if (!rows.length) console.log("  （还是空的：要么他还没纠正过她，要么日总结还没跑）");
      break;
    }
    if (sub === "add") {
      const [key, meaning] = [args[1] ?? "", args.slice(2).join(" ")];
      if (!key || !meaning) {
        console.log('用法：node server/cli.ts habit add "废话" "他早就做过了，是在嫌我问得蠢"');
        break;
      }
      const today = dateStr();
      const r = appendHabits([{
        id: `hb_${today.replace(/-/g, "")}_${Math.random().toString(36).slice(2, 6)}`,
        key, meaning, tags: ["手工"], confidence: 0.7, confirmations: 1, evidence: [],
        source: "import", first_seen: today, last_seen: today,
        created_at: new Date().toISOString(), edited_by: "user",
      } as Habit]);
      console.log(`已入账：+${r.added} 条／确认 ${r.merged} 条`);
      break;
    }
    if (sub === "forget" || sub === "rm") {
      const id = args[1] ?? "";
      const rows = loadHabits();
      const target = rows.find((h) => h.id === id) ?? rows.find((h) => h.key === id);
      if (!target) {
        console.log(`没找到：${id}（也可以直接用 key）`);
        break;
      }
      console.log(forgetHabit(target.id) ? `已删除「${target.key}」` : "删除失败");
      break;
    }
    if (sub === "rebuild") {
      const idx = rebuildHabitIndex();
      console.log(`习惯索引重建完成：${Object.keys(idx.tokens).length} 个 token`);
      break;
    }
    if (sub === "try" || sub === "detect") {
      // 可带 --hist "她上一句" 用来试"他其实是在说我理解错了"那条路
      const rest = args.slice(1);
      const hi = rest.indexOf("--hist");
      const histText = hi >= 0 ? (rest[hi + 1] ?? "") : "";
      const text = rest.filter((_, i) => i !== hi && i !== hi + 1).join(" ");
      const matches = matchHabits(text, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore });
      console.log(`他说：${text}`);
      console.log(matches.length ? `命中 ${matches.length} 条：` : "没有命中任何习惯");
      for (const m of matches) console.log(`  · ${formatHabit(m.habit)}\n      为什么：${m.reasons.join("；")}（分 ${m.score}）`);
      const hist = histText ? [{ role: "pet", content: histText }] : [];
      if (histText) console.log(`她上一句：${histText}`);
      const det = detectCorrection(text, hist);
      console.log(`\n纠正检测：${det ? `✓ 「${det.expr}」= ${det.meaning}${det.misunderstood ? `（以前理解成：${det.misunderstood}）` : ""}（可信 ${det.confidence}；${det.reasons.join("；")}）` : "× 这不像在纠正我"}`);
      break;
    }
    console.log(`用法：
  node server/cli.ts habit list                  看账本
  node server/cli.ts habit add "废话" "真意…"     手工补一条
  node server/cli.ts habit forget <id|key>       删一条
  node server/cli.ts habit rebuild               重建习惯索引
  node server/cli.ts habit try "废话，谁家好人半夜十点还没吃饭"   试一句（含纠正检测）`);
    break;
  }

  case "habit-try": {
    // 把"带着哥哥的习惯实际发出去的提示词"打出来（改完提示词不用重启就能看）
    const text = args.join(" ") || "废话，谁家好人半夜10点还没吃饭";
    const r = await retrieve(text, cfg);
    const hm = matchHabits(text, { limit: cfg.habits.maxInject, minScore: cfg.habits.minScore });
    const msgs = buildReplyMessages(cfg, {
      history: [],
      userText: text,
      memoryText: r.text,
      assocText: r.assocText,
      habitsText: injectText(hm, cfg),
      threadsText: openThreadsText(3),
      canAskSearch: false,
    });
    console.log(`命中习惯 ${hm.length} 条；下面是把提示词真发出去时【哥哥的习惯】那一段的样子：\n`);
    const sys = msgs[0].content;
    const i = sys.indexOf("【哥哥的习惯");
    if (i < 0) console.log("（没有注入这一段 —— 说明这句话没踩到任何习惯）");
    else console.log(sys.slice(i, sys.indexOf("【输出格式")).trim());
    break;
  }

  default:
    console.log(`mind CLI v${"0.1.0-p1"}
命令：
  health                     服务状态（需服务在跑）
  say "今天好累"              走完整链路说一句（SSE 流式，需服务在跑）
  search "面试"               检索记忆（本地，不需要服务）
  why "面试"                  为什么想起某条（打分原因）
  diary [YYYY-MM-DD]         看某天的日记与记忆
  list                       列出情景/情绪记忆
  habit list|add|forget|try  哥哥的习惯账本（情景记忆的分支）
  habit-try "废话…"           看这句话实际注入的【哥哥的习惯】段
  vectors                    补齐所有情景的向量（本地嵌入，离线）
  summarize [日期] [--force]  手动总结（本地）
  tick [--force]             跑一次调度心跳
  state                      运行状态/队列/回收站
  persona                    人格注入预览 + 当前年龄
  mock-day [日期]             造一天假对话（离线测试用）
  reindex                    重建关键词索引
  handover-key <API Key>     把 LLM Key 交给服务端
  test                       证据校验自测（编造事件必须被丢弃）`);
}
