// 联网搜索适配层：供应商可换，统一输出 {title,url,snippet,publishedAt}
// 现在只做"接口与适配"，配好 key 就能用；没配就返回明确原因（不会静默失败）
import type { MindConfig } from "./config.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  source?: string;
}

export interface SearchOutcome {
  ok: boolean;
  provider: string;
  query: string;
  ms: number;
  results: SearchResult[];
  error?: string;
}

const clip = (s: unknown, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}：${txt.slice(0, 200)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

async function get(url: string, headers: Record<string, string>, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}：${txt.slice(0, 200)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

/** 主入口：按配置选供应商 */
export async function webSearch(query: string, cfg: MindConfig): Promise<SearchOutcome> {
  const t0 = Date.now();
  const s = cfg.search;
  const base: SearchOutcome = { ok: false, provider: s.provider, query, ms: 0, results: [] };

  if (!s.enabled || s.provider === "none") {
    return { ...base, ms: Date.now() - t0, error: "搜索未启用（去控制台 → ⚙️ 配置 → 联网搜索里选供应商并填 Key）" };
  }
  if (!query.trim()) return { ...base, error: "query 为空" };
  if (s.provider !== "searxng" && !s.apiKey) {
    return { ...base, ms: Date.now() - t0, error: `供应商 ${s.provider} 需要 API Key（还没填）` };
  }

  try {
    let results: SearchResult[] = [];
    const n = s.maxResults || 5;

    if (s.provider === "bocha") {
      // 博查（国内可用）
      const j = await post(
        s.endpoint || "https://api.bochaai.com/v1/web-search",
        { Authorization: `Bearer ${s.apiKey}` },
        { query, count: n, summary: true },
        s.timeoutMs,
      );
      const pages = j?.data?.webPages?.value ?? j?.webPages?.value ?? [];
      results = pages.slice(0, n).map((p: any) => ({
        title: clip(p.name, 120),
        url: String(p.url ?? ""),
        snippet: clip(p.summary ?? p.snippet, 400),
        publishedAt: p.datePublished,
        source: p.siteName,
      }));
    } else if (s.provider === "tavily") {
      const j = await post(
        s.endpoint || "https://api.tavily.com/search",
        { Authorization: `Bearer ${s.apiKey}` },
        { query, max_results: n, search_depth: "basic" },
        s.timeoutMs,
      );
      results = (j?.results ?? []).slice(0, n).map((p: any) => ({
        title: clip(p.title, 120),
        url: String(p.url ?? ""),
        snippet: clip(p.content, 400),
        publishedAt: p.published_date,
      }));
    } else if (s.provider === "serper") {
      const j = await post(
        s.endpoint || "https://google.serper.dev/search",
        { "X-API-KEY": s.apiKey },
        { q: query, num: n },
        s.timeoutMs,
      );
      results = (j?.organic ?? []).slice(0, n).map((p: any) => ({
        title: clip(p.title, 120),
        url: String(p.link ?? ""),
        snippet: clip(p.snippet, 400),
        publishedAt: p.date,
      }));
    } else if (s.provider === "searxng") {
      // 自建 SearXNG：无需 key
      const url = `${(s.endpoint || "http://127.0.0.1:8888").replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
      const j = await get(url, {}, s.timeoutMs);
      results = (j?.results ?? []).slice(0, n).map((p: any) => ({
        title: clip(p.title, 120),
        url: String(p.url ?? ""),
        snippet: clip(p.content, 400),
        publishedAt: p.publishedDate,
        source: p.engine,
      }));
    } else if (s.provider === "custom") {
      // 自定义：POST {query, count} 到你的端，带 Bearer；返回 {results:[{title,url,snippet}]}
      if (!s.endpoint) return { ...base, ms: Date.now() - t0, error: "custom 供应商需要填 endpoint" };
      const j = await post(s.endpoint, { Authorization: `Bearer ${s.apiKey}` }, { query, count: n }, s.timeoutMs);
      const arr = j?.results ?? j?.data ?? [];
      results = (Array.isArray(arr) ? arr : []).slice(0, n).map((p: any) => ({
        title: clip(p.title, 120),
        url: String(p.url ?? p.link ?? ""),
        snippet: clip(p.snippet ?? p.content ?? p.summary, 400),
        publishedAt: p.publishedAt ?? p.date,
      }));
    } else {
      return { ...base, ms: Date.now() - t0, error: `未知供应商：${s.provider}` };
    }

    return { ok: true, provider: s.provider, query, ms: Date.now() - t0, results };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: (e as Error).message };
  }
}

/** 把搜索结果压成可注入的文本（给她用） */
export function searchToText(o: SearchOutcome, maxChars = 1200): string {
  if (!o.ok || !o.results.length) return "";
  let s = "";
  o.results.forEach((r, i) => {
    const line = `${i + 1}. ${r.title}${r.publishedAt ? `（${String(r.publishedAt).slice(0, 10)}）` : ""}\n   ${r.snippet}\n   ${r.url}`;
    if (s.length + line.length > maxChars) return;
    s += (s ? "\n" : "") + line;
  });
  return s;
}

/** 判断这句话是不是在要求联网搜索（第一版就用最直白的触发词，不做花哨猜测） */
export function isSearchRequest(text: string): { hit: boolean; query: string } {
  const t = text.trim();
  const m = t.match(/^(?:帮我)?(?:搜一下|搜搜|搜索|查一下|查查|联网查|网上查)\s*(.*)$/);
  if (!m) return { hit: false, query: "" };
  return { hit: true, query: (m[1] || "").trim() };
}

/** 搜索是否真的可用（配好了供应商和 key） */
export function searchUsable(cfg: MindConfig): boolean {
  const s = cfg.search;
  if (!s.enabled || s.provider === "none") return false;
  if (s.provider !== "searxng" && !s.apiKey) return false;
  if (s.provider === "custom" && !s.endpoint) return false;
  return true;
}

/**
 * 本地启发式：这句话**可能**需要最新/外部信息吗？
 * 只是"要不要给她一次搜索机会"的闸门 —— 真正决定权在那个小标记（[[搜索: …]]）身上。
 * 目的是：闲聊不花额外调用，只有像查东西的问题才多走一次生成。
 */
const FRESH_PATTERNS: RegExp[] = [
  /最新|最近|今天|今日|昨天|现在|目前|当前|这两天|这几天/,
  /新闻|热搜|头条|发生了什么|怎么回事/,
  /天气|气温|下雨|台风|空气质量/,
  /多少钱|价格|股价|汇率|油价|房价|票价|涨了|跌了/,
  /谁是|是谁|哪一年|哪年|什么时候|多久|多长时间/,
  /谁是冠军|比分|赛程|排名|榜单/,
  /新出的|新番|新游戏|更新了|版本|发售|上映|开播/,
  /怎么用|教程|文档|官网|下载|安装/,
  /在哪|哪里能|哪家|推荐一个|推荐个/,
  /真的吗|是不是真的|求证|查证/,
];

export function looksLikeFreshQuestion(text: string): boolean {
  const t = (text || "").trim();
  if (t.length < 4) return false; // "在吗""哦" 之类直接排除
  if (isSearchRequest(t).hit) return true;
  // 带问号 + 疑问词
  const hasQ = /[?？]/.test(t) || /(吗|呢|吧|么)$/.test(t);
  const hasAsk = /什么|怎么|为什么|如何|哪|谁|多少|几|是不是|能不能|可不可以/.test(t);
  if (hasQ && hasAsk) return true;
  return FRESH_PATTERNS.some((re) => re.test(t));
}

