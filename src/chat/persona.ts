// 人格 → 最终 system prompt：变量替换 + 可选自动注入段（对齐 AstrBot persona 用法）
import type { Persona } from "../core/persona";

export function fillTokens(template: string, map: Record<string, string>): string {
  let s = template;
  for (const k of Object.keys(map)) {
    s = s.split("{{" + k + "}}").join(map[k] || "");
  }
  return s;
}

/** prompt = 已做变量替换的人设原文；autoCtx = 可选"实时状态"自动注入段 */
export function buildPersonaPrompt(
  prompt: string,
  p: Pick<Persona, "name" | "useAutoContext" | "enforceShort">,
  autoCtx: string,
): string {
  let s = (prompt || "").trim();
  if (p.useAutoContext && autoCtx.trim()) {
    s += `\n\n[当前实时状态]\n${autoCtx.trim()}`;
  }
  if (p.enforceShort) {
    s += `\n\n[系统附注]\n请以「${p.name}」的身份自然回应，保持上述人设；回复简短口语化（一般不超过两句话）；不要暴露你是 AI 或程序。`;
  }
  return s;
}
