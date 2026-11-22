// 向量维护：入库时生成、缺失时补齐、删记忆时清理。
// 与 embed.ts 的分工：embed.ts 只管"文本→向量"（模型怎么加载），这里管"什么时候算、存哪儿"。
import { loadEpisodic, loadVectors, upsertVectors, pruneVectors, type Episode } from "./store.ts";
import { embedAvailable, embed, episodeText, hashText } from "./embed.ts";

/** 给一批情景算向量并落盘（内容没变就跳过）。失败只记录，不影响调用方 */
export async function embedEpisodes(
  list: Episode[],
): Promise<{ embedded: number; skipped: number }> {
  if (!list.length || !embedAvailable()) return { embedded: 0, skipped: list.length };
  const cur = new Map(loadVectors().map((v) => [v.id, v]));
  const todo = list.filter((ep) => cur.get(ep.id)?.hash !== hashText(episodeText(ep)));
  if (!todo.length) return { embedded: 0, skipped: list.length };
  try {
    const texts = todo.map(episodeText);
    const vecs = await embed(texts);
    upsertVectors(
      todo.map((ep, i) => ({
        id: ep.id,
        date: ep.date,
        hash: hashText(texts[i]),
        dim: vecs[i].length,
        vec: vecs[i],
      })),
    );
    console.log(`[vectors] 生成 ${todo.length} 条向量（本地嵌入）`);
    return { embedded: todo.length, skipped: list.length - todo.length };
  } catch (e) {
    console.warn("[vectors] 生成失败（退回纯关键词检索）：", (e as Error).message);
    return { embedded: 0, skipped: list.length };
  }
}

/** 补齐所有情景的向量（导入初始记忆、换了模型、手动 reindex 时用） */
export async function backfillVectors(): Promise<{
  total: number;
  embedded: number;
  failed: number;
  available: boolean;
}> {
  const eps = loadEpisodic();
  if (!embedAvailable()) {
    return { total: eps.length, embedded: 0, failed: eps.length, available: false };
  }
  const cur = new Map(loadVectors().map((v) => [v.id, v]));
  const todo = eps.filter((ep) => cur.get(ep.id)?.hash !== hashText(episodeText(ep)));
  let done = 0;
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16); // 分批，避免一次塞太多进模型
    const texts = batch.map(episodeText);
    try {
      const vecs = await embed(texts);
      upsertVectors(
        batch.map((ep, j) => ({
          id: ep.id,
          date: ep.date,
          hash: hashText(texts[j]),
          dim: vecs[j].length,
          vec: vecs[j],
        })),
      );
      done += batch.length;
    } catch (e) {
      console.warn("[vectors] 批次失败：", (e as Error).message);
    }
  }
  pruneVectors(new Set(eps.map((e) => e.id))); // 顺手清掉"情景已删、向量还留着"的
  return { total: eps.length, embedded: done, failed: todo.length - done, available: true };
}
