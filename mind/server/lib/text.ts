// 中文文本处理：无分词器的轻量方案（字符二元组 + ASCII 词 + 停用词）
// 记忆检索靠它 + LLM 抽取的 keywords/entities，够用且零依赖

const STOP = new Set([
  "的","了","是","我","你","他","她","它","们","在","有","和","就","都","而","及","与","着","或","一个","没有","我们",
  "你们","他们","这个","那个","这些","那些","什么","怎么","为什么","因为","所以","但是","然后","可以","不是","这样",
  "那样","一下","现在","今天","明天","昨天","已经","还是","就是","知道","觉得","可能","应该","真的","好像","感觉",
  "the","a","an","is","are","was","were","to","of","in","on","and","or","for","it","this","that","i","you","he","she",
]);

/** 切成检索用 token：ASCII 词 + 中文二元组（长词也保留单字组合的可召回性） */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const s = text.toLowerCase();
  const out: string[] = [];

  // ASCII 词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);

  // 中文串 → 二元组
  for (const run of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const w = run[0];
    if (w.length === 1) {
      out.push(w);
      continue;
    }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  }
  return out.filter((t) => !STOP.has(t));
}

/** 词频统计（去重后的集合也常用） */
export function termFreq(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/** 截断到 n 个字符（尽量不切断句子） */
export function clip(text: string, n: number): string {
  if (!text) return "";
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("，"), cut.lastIndexOf("\n"));
  return (p > n * 0.6 ? cut.slice(0, p + 1) : cut) + "…";
}
