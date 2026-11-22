// Only explicitly uploaded chat images are stored here. Screen captures never
// pass through this module. Paths are content hashes, never client filenames.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { P } from "./paths.ts";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export interface UploadedImage { id: string; mime: string; bytes: number }
export function parseChatImage(input: unknown): { buffer: Buffer; mime: string } | undefined {
  if (input === undefined || input === null || input === "") return;
  if (typeof input !== "string") throw Error("图片必须是base64编码");
  const encoded = input.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/i, "");
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw Error("图片超过8MB，请换一张较小的图片");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw Error("图片编码无效，请重新选择图片");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > MAX_IMAGE_BYTES || buffer.length < 12) throw Error("图片大小无效");
  const mime = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? "image/jpeg"
    : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
    : /GIF8[79]a/.test(buffer.toString("ascii", 0, 6)) ? "image/gif" : "";
  if (!mime) throw Error("支持PNG、JPEG、WebP或GIF图片，不支持此格式");
  return { buffer, mime };
}
export function saveChatImage(parsed: { buffer: Buffer; mime: string }): UploadedImage {
  const id = crypto.createHash("sha256").update(parsed.buffer).digest("hex");
  const dir = path.join(P.data, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id);
  // Do not replace existing uploads. An identical attachment can be reused.
  try { fs.writeFileSync(file, parsed.buffer, { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  return { id, mime: parsed.mime, bytes: parsed.buffer.length };
}

export function loadChatImage(id: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(id)) return;
  try {
    const file = path.join(P.data, "attachments", id);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return;
    const buffer = fs.readFileSync(file);
    if (crypto.createHash("sha256").update(buffer).digest("hex") !== id) return;
    const parsed = parseChatImage(buffer.toString("base64"));
    return parsed ? `data:${parsed.mime};base64,${buffer.toString("base64")}` : undefined;
  } catch { return; }
}

/** Include at most three recent uploads, preserving original message position.
 * Raw image bytes are never put into the transcript, retrieval or a log.
 */
export function withChatImages<T extends { role: string; content: string; imageId?: string }>(messages: T[]): Array<T & { images?: string[] }> {
  const chosen = new Set(messages.map((m, i) => ({m,i})).slice(-14).filter(({m}) => m.role === "user" && m.imageId).slice(-3).map(({i}) => i));
  return messages.map((m, i) => {
    if (m.role !== "user" || !m.imageId) return m;
    if (!chosen.has(i)) return { ...m, content: m.content + "\n（此条较早的图片本轮未附带，若需核对细节请用户重发，不要凭空猜测。）" };
    const image = loadChatImage(m.imageId);
    return image ? { ...m, images: [image] } : { ...m, content: m.content + "\n（此条旧图片附件已不可用，不能假装看到了图片细节。）" };
  });
}
