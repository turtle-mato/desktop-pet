// OpenAI 兼容的流式对话 provider（docs/教程/第08课：Chat Completions + SSE）
import { env } from "../core/env";
export interface ProviderCfg {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  devProxy?: boolean;
  temperature?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

function normalizeBase(url: string): string {
  let u = (url || "https://api.deepseek.com").replace(/\/+$/, "");
  if (u.endsWith("/v1")) u = u.slice(0, -3);
  return u;
}

function imageDataUrl(image: string): string {
  if (image.startsWith("data:")) return image;
  const mime = image.startsWith("iVBOR") ? "image/png" : image.startsWith("UklG") ? "image/webp"
    : image.startsWith("R0lG") ? "image/gif" : "image/jpeg";
  return `data:${mime};base64,${image}`;
}

/** 发起一次流式对话，onDelta 拿到累积文本 */
export async function chatStream(
  cfg: ProviderCfg,
  messages: ChatMessage[],
  onDelta: (full: string) => void,
): Promise<string> {
  const body = {
    model: cfg.model || "deepseek-chat",
    messages: messages.map(m => ({role: m.role, content: m.role === "user" && m.images?.length
      ? [{type:"text",text:m.content}, ...m.images.map(image => ({type:"image_url",image_url:{url:imageDataUrl(image),detail:"high"}}))]
      : m.content})),
    stream: true,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0.8,
  };

  // 开发/桌面统一走本地代理（启动器自带 /dsai 转发；浏览器 dev 由 Vite 代理）
  const url = cfg.devProxy
    ? `${env.serverBase}/dsai/chat/completions`
    : `${normalizeBase(cfg.baseUrl)}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}：${t.slice(0, 200)}`);
  }

  if (!res.body) throw new Error("无响应流");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          full += d;
          onDelta(full);
        }
      } catch {
        // 忽略不完整行
      }
    }
  }
  return full;
}
