// LLM 客户端：真实（DeepSeek / 任意 OpenAI 兼容）+ mock（离线自测用）
// 只用 Node 内置 fetch，无第三方依赖
import type { MindConfig } from "./config.ts";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
  /** Actual image data URLs, kept out of persisted dialogue content. */
  images?: string[];
}

export interface LlmUsage {
  model: string;
  ms: number;
  approxInChars: number;
  approxOutChars: number;
  /** 思考内容的长度（开了思考才有，仅用于观测） */
  reasoningChars?: number;
  emptyRecovery?: boolean;
}

function endpoint(cfg: MindConfig): string {
  const base = (cfg.llm.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const b = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${b}/chat/completions`;
}

type ThinkingLevel = "off" | "low" | "high" | "max";

/**
 * 看图：把一张 base64 JPEG 交给视觉模型，换回一段描述。
 * 用的是同一套 llm 配置和 key；模型名固定为支持图像的 deepseek-flash。
 */
export async function chatVision(
  cfg: MindConfig,
  imageBase64: string,
  question: string,
  opts: { maxTokens?: number; model?: string } = {},
): Promise<{ text: string; model: string; ms: number }> {
  const t0 = Date.now();
  if (!cfg.llm.apiKey) throw new Error("没有配置 LLM API Key");
  // 实测（2026-11-01）：同一个 key 下 deepseek-flash 会返回 200 但 content 为空，
  // deepseek-chat 反而能正常看图。所以默认跟随主模型配置，别再写死。
  const model = opts.model || cfg.llm.model || "deepseek-chat";
  const res = await fetch(endpoint(cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "low" } },
          ],
        },
      ],
      max_tokens: opts.maxTokens ?? 520,
      temperature: 0.4,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`视觉接口 HTTP ${res.status} ${t.slice(0, 160)}`);
  }
  const j: any = await res.json();
  const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("视觉接口没有返回内容");
  return { text, model, ms: Date.now() - t0 };
}

/**
 * 组装请求体。
 * 思考模式（官方文档 https://api-docs.deepseek.com/guides/thinking_mode/）：
 *   开关 {"thinking":{"type":"enabled"}}，强度 reasoning_effort: low | high | max
 * 注意：思考模式下 temperature 无效（官方忽略、不报错），所以干脆不传。
 */
function buildBody(
  cfg: MindConfig,
  opts: {
    model: string;
    messages: ChatMsg[];
    stream: boolean;
    thinking?: ThinkingLevel;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
  },
): Record<string, unknown> {
  const thinking: ThinkingLevel = opts.thinking ?? cfg.llm.thinking ?? "off";
  // Keep system instructions together before conversation turns. Interleaved
  // system messages reproduced a reasoning-only, empty final on the live model.
  // Preserve their order and every user/assistant turn, including image bytes.
  const systems = opts.messages.filter(m => m.role === "system");
  const ordered = [
    ...(systems.length ? [{ role: "system" as const, content: systems.map(m => m.content).join("\n\n") }] : []),
    ...opts.messages.filter(m => m.role !== "system"),
  ];
  const messages = ordered.map(m => ({ role: m.role, content: m.role === "user" && m.images?.length
    ? [{ type: "text", text: m.content }, ...m.images.map(url => ({ type: "image_url", image_url: { url, detail: "high" } }))]
    : m.content }));
  const body: Record<string, unknown> = { model: opts.model, messages, stream: opts.stream };
  if (thinking !== "off") {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = thinking;
  } else {
    // Explicitly turn thinking off for a recovery request; absence can inherit
    // the provider/model default instead of disabling it.
    body.thinking = { type: "disabled" };
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  }
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;
  // JSON 模式与思考模式并用有冲突风险 → 思考时不用 response_format，靠提示词 + 宽松解析
  if (opts.json && thinking === "off") body.response_format = { type: "json_object" };
  return body;
}

/** 流式对话（用于 /v1/message）；返回完整文本。思维链（reasoning_content）不会外泄给前端 */
export async function chatStream(
  cfg: MindConfig,
  messages: ChatMsg[],
  onDelta: (full: string) => void,
  opts: { temperature?: number; model?: string; thinking?: ThinkingLevel; maxTokens?: number; recoverEmpty?: boolean; timeoutMs?: number } = {},
): Promise<{ text: string; usage: LlmUsage }> {
  const t0 = Date.now();
  const model = opts.model || cfg.llm.model;

  if (cfg.llm.mode === "mock") {
    if (messages.some(m => m.images?.length)) throw new Error("当前是离线模拟模式，无法查看图片，请连接支持看图的模型");
    return mockStream(messages, onDelta, model, t0);
  }
  if (!cfg.llm.apiKey) throw new Error("没有配置 LLM API Key（mind/config.json 的 llm.apiKey，或环境变量 DEEPSEEK_API_KEY）");

  const res = await fetch(endpoint(cfg), {
    method: "POST",
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify(
      buildBody(cfg, {
        model,
        messages,
        stream: true,
        thinking: opts.thinking,
        temperature: opts.temperature ?? cfg.llm.temperature,
        maxTokens: opts.maxTokens,
      }),
    ),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}：${t.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let reasoningChars = 0; // 思维链只统计不外泄
  let finishReason = "";
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(payload); } catch { return; }
    if (j.error) throw new Error(`模型流返回错误：${String(j.error.message || j.error.code || "未知错误").slice(0, 160)}`);
    const choice = j.choices?.[0];
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    const delta = choice?.delta;
    if (delta?.reasoning_content) reasoningChars += String(delta.reasoning_content).length;
    if (typeof delta?.content === "string") {
      full += delta.content;
      onDelta(full);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      consume(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) consume(buf.trim());
  if (!full.trim()) {
    const thinking = opts.thinking ?? cfg.llm.thinking ?? "off";
    if (opts.recoverEmpty && thinking !== "off" && reasoningChars > 0 && finishReason === "stop") {
      // Only an ordinary chat caller opts in. No retry on HTTP/stream errors,
      // filtering or truncation; no second paid request for proactive skips.
      const retry = await chatStream(cfg, messages, onDelta, {
        ...opts, thinking: "off", recoverEmpty: false, maxTokens: opts.maxTokens ?? 1024,
      });
      return { text: retry.text, usage: {
        ...retry.usage, ms: Date.now() - t0, emptyRecovery: true,
        reasoningChars: reasoningChars + (retry.usage.reasoningChars || 0),
        approxInChars: retry.usage.approxInChars + messages.reduce((n, m) => n + m.content.length, 0),
      } };
    }
    throw new Error(`模型未返回正文（结束原因：${finishReason || "流中断"}，思考字符：${reasoningChars}），请重试`);
  }
  return {
    text: full,
    usage: {
      model,
      ms: Date.now() - t0,
      approxInChars: messages.reduce((n, m) => n + m.content.length, 0),
      approxOutChars: full.length,
      reasoningChars,
    },
  };
}

/** 要结构化 JSON 的非流式调用（日总结/归纳用），带一次自动修复重试 */
export async function chatJson<T = any>(
  cfg: MindConfig,
  messages: ChatMsg[],
  opts: { temperature?: number; model?: string; maxTokens?: number; thinking?: ThinkingLevel } = {},
): Promise<{ data: T; raw: string; usage: LlmUsage }> {
  const t0 = Date.now();
  const model = opts.model || cfg.llm.summaryModel || cfg.llm.model;

  if (cfg.llm.mode === "mock") {
    const raw = mockJson(messages);
    return { data: parseJsonLoose<T>(raw)!, raw, usage: { model: "mock", ms: Date.now() - t0, approxInChars: 0, approxOutChars: raw.length } };
  }
  if (!cfg.llm.apiKey) throw new Error("没有配置 LLM API Key");

  const call = async (msgs: ChatMsg[]): Promise<string> => {
    const res = await fetch(endpoint(cfg), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.llm.apiKey}` },
      body: JSON.stringify(
        buildBody(cfg, {
          model,
          messages: msgs,
          stream: false,
          thinking: opts.thinking ?? cfg.llm.summaryThinking ?? "high",
          temperature: opts.temperature ?? cfg.llm.summaryTemperature,
          maxTokens: opts.maxTokens ?? cfg.llm.maxTokensSummary,
          json: true,
        }),
      ),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}：${t.slice(0, 200)}`);
    }
    const j: any = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
  };

  let raw = await call(messages);
  let data = parseJsonLoose<T>(raw);
  if (data === null) {
    // 修一次：告诉模型"你上次输出的不是合法 JSON"
    raw = await call([
      ...messages,
      { role: "assistant", content: raw.slice(0, 800) },
      { role: "user", content: "上面这段不是合法 JSON。请只输出一个合法 JSON 对象，不要任何解释、不要代码块围栏。" },
    ]);
    data = parseJsonLoose<T>(raw);
  }
  if (data === null) throw new Error("LLM 未能返回合法 JSON");

  return {
    data,
    raw,
    usage: { model, ms: Date.now() - t0, approxInChars: messages.reduce((n, m) => n + m.content.length, 0), approxOutChars: raw.length },
  };
}

/** 宽松解析：容忍 ```json 围栏、前后废话、以及被截断的尾巴 */
export function parseJsonLoose<T = any>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  const end = s.lastIndexOf("}");
  const candidates = [s.slice(start, end + 1)];
  if (end < start) candidates.push(s.slice(start));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // 尝试补齐被截断的括号
      const fixed = c.replace(/,\s*$/, "") + "}".repeat(Math.max(0, (c.match(/{/g)?.length ?? 0) - (c.match(/}/g)?.length ?? 0)));
      try {
        return JSON.parse(fixed) as T;
      } catch {
        /* 继续 */
      }
    }
  }
  return null;
}

// ---------------- mock 模式（离线自测：跑通流水线、验证证据校验） ----------------
function mockStream(messages: ChatMsg[], onDelta: (s: string) => void, model: string, t0: number) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = `（mock 回复）我听到你说：${last.slice(0, 40)}`;
  let acc = "";
  for (const ch of text) {
    acc += ch;
    onDelta(acc);
  }
  return { text, usage: { model: `${model}(mock)`, ms: Date.now() - t0, approxInChars: 0, approxOutChars: text.length } };
}

/**
 * mock 的抽取输出：日总结故意包含一条"编造事件"（不存在的消息 id），用于验证证据校验会丢弃它。
 * 哥哥的习惯（buildHabitMessages 那条路）也返回一条真证据 + 一条假证据，两条链路都能离线自测。
 */
function mockJson(messages: ChatMsg[]): string {
  const user = messages.map((m) => m.content).join("\n");
  const isHabit = messages[0]?.content?.includes("哥哥的习惯") ?? false;
  const ids = Array.from(user.matchAll(/\[(m_\d{8}_\d{4})\]/g)).map((m) => m[1]);
  const first = ids[0] ?? "m_00000000_0000";
  const second = ids[1] ?? first;

  if (isHabit) {
    return JSON.stringify({
      habits: [
        {
          key: "今天好累",
          meaning: "他今天真的累了，是在求安慰，不是在拒绝聊天",
          misunderstood: "以为他不想理我",
          tone: "认真",
          behavior: "先接住他的累，别急着说自己的事",
          tags: ["求安慰"],
          confidence: 0.7,
          evidence: [first],
        },
        {
          key: "编造习惯（用于测试证据校验）",
          meaning: "这条引用了不存在的消息 id，必须被丢弃",
          tags: [],
          confidence: 0.9,
          evidence: ["m_19990101_9999"],
        },
      ],
    });
  }

  return JSON.stringify({
    diary: "今天哥哥来找我说话了。他有点累，我陪他聊了一会儿。（mock 日记）",
    episodes: [
      {
        title: "哥哥今天有点累",
        summary: "哥哥说他今天很累，我陪他聊了几句。",
        time: "",
        review: "他说累的时候是想被接住，不是想听建议。下次先说「那你歇着」，别急着出主意。",
        people: ["哥哥"],
        entities: [],
        tags: ["日常"],
        keywords: ["累", "聊天"],
        salience: 0.5,
        evidence: [first, second],
      },
      {
        title: "编造事件（用于测试证据校验）",
        summary: "这条故意引用不存在的消息 id，必须被丢弃。",
        people: [],
        entities: [],
        tags: [],
        keywords: [],
        salience: 0.9,
        evidence: ["m_19990101_9999"],
      },
    ],
    emotions: [
      {
        episode_title: "哥哥今天有点累",
        emotion: "心疼",
        valence: -0.2,
        arousal: 0.3,
        cause: "哥哥说累",
        intensity: 0.5,
        evidence: [first],
      },
    ],
    open_threads: [],
  });
}
