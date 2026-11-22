// 本地嵌入（bge-small-zh-v1.5）：完全离线，不联网、不花钱。
// 依赖放在 mind/vendor（mind 本体保持零依赖），模型在 mind/models。
// 用途两处：① 语义召回（换个说法也能想起来）② 联想（用"邻居"当"这件事让你想起那件事"）
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MIND_ROOT } from "./paths.ts";

export const MODEL_NAME = "bge-small-zh-v1.5";
export const EMBED_DIM = 512;

const LIB = path.join(
  MIND_ROOT,
  "vendor",
  "node_modules",
  "@xenova",
  "transformers",
  "src",
  "transformers.js",
);
// transformers.js 要的是"目录 + 分隔符"，模型按 <localModelPath>/<模型名> 去找
const MODELS_DIR = path.join(MIND_ROOT, "models") + path.sep;
const MODEL_FILE = path.join(MIND_ROOT, "models", MODEL_NAME, "onnx", "model_quantized.onnx");

/** 依赖与模型在不在。不在就静默退回纯关键词检索——聊天不能因为少了向量就不能用 */
export function embedAvailable(): boolean {
  return fs.existsSync(LIB) && fs.existsSync(MODEL_FILE);
}

let pipe: any = null;
let loading: Promise<any> | null = null;

async function getPipe(): Promise<any> {
  if (pipe) return pipe;
  if (!loading) {
    loading = (async () => {
      const mod: any = await import(pathToFileURL(LIB).href);
      mod.env.allowRemoteModels = false; // 关键：只读本地目录，彻底离线
      mod.env.allowLocalModels = true;
      mod.env.localModelPath = MODELS_DIR;
      const t0 = Date.now();
      const p = await mod.pipeline("feature-extraction", MODEL_NAME, { quantized: true });
      console.log(`[embed] ${MODEL_NAME} 就绪（${Date.now() - t0}ms，${EMBED_DIM} 维，纯本地）`);
      pipe = p;
      return p;
    })().catch((e) => {
      loading = null; // 失败不缓存，下次可以重试
      throw e;
    });
  }
  return loading;
}

/** 编码一批文本 → 归一化向量（余弦 = 点积）。数值留 5 位小数：落盘可读、体积也小 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const p = await getPipe();
  const out = await p(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1];
  const res: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const v = new Array<number>(dim);
    for (let j = 0; j < dim; j++) v[j] = Math.round(out.data[i * dim + j] * 1e5) / 1e5;
    res.push(v);
  }
  return res;
}

/** 余弦相似度（两边都已归一化，直接点积） */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 一条情景参与编码的文本：标题 + 摘要 + 关键词（技术文档定的拼法） */
export function episodeText(ep: { title: string; summary: string; keywords?: string[] }): string {
  return [ep.title, ep.summary, (ep.keywords ?? []).join("、")].filter(Boolean).join("。");
}

/** 文本指纹（内容变了要重算向量） */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
