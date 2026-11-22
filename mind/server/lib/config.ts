// 配置：mind/config.json（首次运行自动生成）+ 环境变量覆盖
import fs from "node:fs";
import crypto from "node:crypto";
import { CONFIG_PATH } from "./paths.ts";

export interface MindConfig {
  /** HTTP 服务 */
  port: number;
  host: string;
  /** 前端连接用的令牌（首次生成后写入 config.json） */
  token: string;
  /** 空闲调度 */
  idleMinutes: number; // 连续无对话多久算"空闲"（可触发总结）
  startupGraceMinutes: number; // 启动后多久才开始考虑总结
  summaryCooldownMinutes: number; // 两次总结之间的最小间隔
  trashDays: number; // 回收站保留天数
  minMessages: number; // 一天少于这么多条有效消息就不调 LLM
  /** 拟人价值下限：低于它的记忆不入库（记性好就能复现的事、纯解题讲题都算低分） */
  minSalience: number;
  segmentGapMinutes: number; // 话题分段的时间间隔
  /** 检索与注入预算 */
  retrieve: {
    topK: number;
    maxChars: number;
    halfLifeDays: number;
    /** 召回方式：hybrid=关键词+本地嵌入语义（默认），keyword=只用关键词 */
    mode: "hybrid" | "keyword";
    /** 向量召回的候选条数（再和关键词做 RRF 融合） */
    vectorTopK: number;
    /** 向量召回的最低相似度：低于它的不入选，否则"库里东西少"时会把不相干的事也拽出来 */
    vectorMin: number;
    /** RRF 的平滑常数（越大越平均；60 是常用默认值） */
    rrfK: number;
    /** L2 联想：由想起的事牵出另一件事（向量邻居 + 同情绪） */
    assoc: boolean;
    /** 邻居相似度区间：太低不像、太高就是同一件事 */
    assocMin: number;
    assocMax: number;
  };
  /** LLM */
  llm: {
    mode: "deepseek" | "mock";
    baseUrl: string;
    apiKey: string;
    model: string;
    summaryModel: string;
    temperature: number;
    summaryTemperature: number;
    maxTokensSummary: number;
    /** 思考程度：off=不思考，其他对应 reasoning_effort（max 最大） */
    thinking: "off" | "low" | "high" | "max";
    /** 日总结/抽取时的思考程度（要准，默认 high） */
    summaryThinking: "off" | "low" | "high" | "max";
  };
  /** 人格与年龄 */
  persona: {
    /** 生日（YYYY-MM-DD）。留空则用 baseAge 固定年龄 */
    birthDate: string | null;
    /** birthDate 为空时的兜底年龄 */
    baseAge: number;
    name: string;
    /** 主人称呼 */
    userName: string;
  };
  /** 主动聊天（P2：话题池 + 投递策略；配比与硬规则见记忆方案 §16） */
  proactive: {
    enabled: boolean;
    maxPerDay: number;
    recallRatio: number; // 回忆类话题占比上限（主人定为 0.33）
    /** 两次主动之间的最小间隔（分钟） */
    minGapMinutes: number;
    quietStartHour: number; // 安静时段：不主动打扰
    quietEndHour: number;
    /** 同一个话题多少天内不重复 */
    repeatDays: number;
    /** 具体画面事件的陪看通道；缺省时使用独立默认限额。 */
    coView?: { enabled: boolean; minGapMinutes: number; maxPerDay: number; repeatMinutes: number };
    dailyRoutines?: { enabled: boolean; weather: boolean };
  };
  /** 哥哥的习惯（情景记忆的分支）：他的表达 → 真意，用来减少"理解错" */
  habits: {
    enabled: boolean;
    /** 日总结时顺便抽取/更新「哥哥的习惯」 */
    extract: boolean;
    /** 一次注入最多几条 */
    maxInject: number;
    /** 注入文本的字符预算 */
    maxChars: number;
    /** 匹配门槛（越高越保守，宁可不说也别猜错） */
    minScore: number;
  };
  /** 联网搜索（供应商可换；没配就明确提示，不静默失败） */
  search: {
    enabled: boolean;
    /** 自动判断该不该联网（关掉=只有你说"搜一下"才查） */
    auto: boolean;
    provider: "none" | "bocha" | "tavily" | "serper" | "searxng" | "custom";
    apiKey: string;
    endpoint: string;
    maxResults: number;
    timeoutMs: number;
  };
}

const DEFAULT_CONFIG: MindConfig = {
  port: 8430,
  host: "127.0.0.1",
  token: "",
  idleMinutes: 20,
  startupGraceMinutes: 5,
  summaryCooldownMinutes: 10,
  trashDays: 2,
  minMessages: 6,
  minSalience: 0.4,
  segmentGapMinutes: 30,
  retrieve: {
    topK: 4,
    maxChars: 1400,
    halfLifeDays: 30,
    mode: "hybrid",
    vectorTopK: 12,
    vectorMin: 0.5,
    rrfK: 60,
    assoc: true,
    assocMin: 0.55,
    assocMax: 0.9,
  },
  llm: {
    mode: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    summaryModel: "deepseek-chat",
    temperature: 0.8,
    summaryTemperature: 0.2,
    maxTokensSummary: 2000,
    thinking: "max",
    summaryThinking: "high",
  },
  persona: {
    birthDate: null,
    baseAge: 15,
    name: "林阅心",
    userName: "哥哥",
  },
  proactive: {
    enabled: true,
    maxPerDay: 3,
    recallRatio: 0.33,
    minGapMinutes: 45,
    quietStartHour: 23,
    quietEndHour: 7,
    repeatDays: 3,
    coView: { enabled: true, minGapMinutes: 3, maxPerDay: 12, repeatMinutes: 10 },
    dailyRoutines: {enabled:true,weather:true},
  },
  habits: {
    enabled: true,
    extract: true,
    maxInject: 3,
    maxChars: 360,
    minScore: 2,
  },
  search: {
    enabled: false,
    auto: true,
    provider: "none",
    apiKey: "",
    endpoint: "",
    maxResults: 5,
    timeoutMs: 8000,
  },
};

/** HTTP 配置和直接调用共用钳制，不能用负数/非有限值绕过陪看节流。 */
export function coViewConfig(value: unknown): NonNullable<MindConfig["proactive"]["coView"]> {
  const v = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const n = v[key];
    return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  };
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : true,
    minGapMinutes: bounded("minGapMinutes", 3, 2, 60),
    maxPerDay: bounded("maxPerDay", 12, 1, 48),
    repeatMinutes: bounded("repeatMinutes", 10, 1, 1440),
  };
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base;
  // base 是 null/undefined（例如 persona.birthDate 还没设）时必须直接取 patch：
  // 否则 typeof null === "object" 会走到下面按 key 合并，`(null)["0"]` 直接抛错。
  // 真实踩过：面板里设置生日报 "Cannot read properties of null (reading '0')"。
  if (base === null || base === undefined) return patch as T;
  if (
    Array.isArray(base) ||
    Array.isArray(patch) ||
    typeof base !== "object" ||
    typeof patch !== "object"
  ) {
    return patch as T;
  }
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge((base as any)[k], patch[k]);
  }
  return out;
}

let cached: MindConfig | null = null;

export function loadConfig(reload = false): MindConfig {
  if (cached && !reload) return cached;

  let cfg = DEFAULT_CONFIG;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
    } catch (e) {
      console.error("[config] config.json 解析失败，使用默认配置：", (e as Error).message);
    }
  }

  // 环境变量覆盖（方便临时换 key / 切 mock）
  if (process.env.MIND_PORT) cfg.port = Number(process.env.MIND_PORT);
  if (process.env.DEEPSEEK_API_KEY) cfg.llm.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.MIND_LLM_MODE) cfg.llm.mode = process.env.MIND_LLM_MODE as any;
  if (process.env.MIND_TOKEN) cfg.token = process.env.MIND_TOKEN;

  cfg.proactive.coView = coViewConfig(cfg.proactive.coView);
  if (!cfg.token) cfg.token = crypto.randomBytes(16).toString("hex");
  cached = cfg;
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: MindConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export function patchConfig(patch: any): MindConfig {
  const cfg = deepMerge(loadConfig(true), patch);
  cfg.proactive.coView = coViewConfig(cfg.proactive.coView);
  cached = cfg;
  saveConfig(cfg);
  return cfg;
}
