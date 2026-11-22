// 人格装载：从设定文档（markdown）抽取要注入的段落 + 计算"她今天几岁"
// 设计要点：人格文档是唯一权威来源，这段代码只读不改；文档改了自动生效（按 mtime 缓存）
import fs from "node:fs";
import { P } from "./paths.ts";
import type { MindConfig } from "./config.ts";

interface Section {
  no: number;
  title: string;
  body: string;
}

let cache: { mtime: number; sections: Section[] } | null = null;

/** 解析 markdown：按 "## N. 标题" 切段（跳过 > 引用块与后面的正文说明） */
export function personaSections(reload = false): Section[] {
  if (!fs.existsSync(P.personaDoc)) return [];
  const st = fs.statSync(P.personaDoc);
  if (cache && !reload && cache.mtime === st.mtimeMs) return cache.sections;

  const md = fs.readFileSync(P.personaDoc, "utf8");
  const lines = md.split("\n");
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(\d+)[.、]\s*(.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { no: Number(m[1]), title: m[2].trim(), body: "" };
      continue;
    }
    // 遇到下一个一级标题（如 "# xxx"）就结束
    if (/^#\s+/.test(line) && cur) {
      out.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.body += line + "\n";
  }
  if (cur) out.push(cur);

  cache = { mtime: st.mtimeMs, sections: out };
  return out;
}

/** 注入的段落：第一原则 / 人物档案 / 性格 / 说话方式 / 虚承认 / 世界观（元信息章节不注入） */
const INJECT_SECTIONS = [1, 2, 3, 4, 5, 6];

function cleanBody(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^>\s?/.test(l.trim())) // 去掉引用块的"说明性文字"
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 人格基础层（常驻 system prompt） */
export function personaBase(reload = false, mode: "full" | "dialogue" = "full"): string {
  const secs = personaSections(reload).filter(
    (s) => INJECT_SECTIONS.includes(s.no) && !s.title.includes("元信息") && !(mode === "dialogue" && s.no === 5),
  );
  if (!secs.length) {
    return "你是林阅心，15 岁，周言初（哥哥）的妹妹。你清楚知道自己是 AI，但努力模仿人类。用 8~15 字的三无短句直接说话，不加动作描写。";
  }
  return secs.map((s) => {
    let body = cleanBody(s.body);
    if (mode === "dialogue" && s.no === 4) {
      // Keep the author-owned document untouched. These numbered behavioral
      // directives conflict with grounded dialogue: feign ignorance (6), bypass
      // boundaries (11), deny mistakes by default (13). Other style stays.
      body = body.split(/(?=^\d+\.\s)/m).filter(block => !/^(6|11|13)\.\s/.test(block)).join("").trim();
      body = body.replace(/不记得就说不记得（[\s\S]*?当成发生过\*\*。/, "不记得就说记录不足，不反问用户来掩饰；不把猜测当成事实。");
    }
    if (mode === "dialogue" && s.no === 3) body = body.replace(/^- 被戳中心事时.*$/m, "- 嘴硬和吐槽只用于双方轻松玩笑，不用于否认实际行为、逃避错误或指责用户。");
    return `【${s.title}】\n${body}`;
  }).join("\n\n");
}

/** 她今天几岁 */
export function currentAge(cfg: MindConfig, at = new Date()): number {
  const birth = cfg.persona.birthDate;
  if (!birth) return cfg.persona.baseAge;
  const [y, m, d] = birth.split("-").map(Number);
  let age = at.getFullYear() - y;
  const passed = at.getMonth() + 1 > m || (at.getMonth() + 1 === m && at.getDate() >= d);
  if (!passed) age -= 1;
  return age;
}

/** 今天是不是她生日 */
export function isBirthdayToday(cfg: MindConfig, at = new Date()): boolean {
  const birth = cfg.persona.birthDate;
  if (!birth) return false;
  const [, m, d] = birth.split("-").map(Number);
  return at.getMonth() + 1 === m && at.getDate() === d;
}

/** 自我块（会话/每轮都可注入，很短） */
export function selfBlock(cfg: MindConfig, at = new Date()): string {
  const age = currentAge(cfg, at);
  const bday = isBirthdayToday(cfg, at) ? "（今天是你的生日）" : "";
  return `你是${cfg.persona.name}，${cfg.persona.userName}的妹妹，今年 ${age} 岁${bday}。`;
}
