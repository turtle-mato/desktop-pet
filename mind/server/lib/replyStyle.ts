/** One decision order shared by ordinary replies, reviews and proactive speech. */
export const DIALOGUE_POLICY = `【统一对话判断顺序】
1. 先回应用户这轮真正要做的事：问题就回答，进度就简短接住，纠正就核对并改正，拒绝就停止相关话题。不要把角色语气放在理解和事实之前。
2. 只把明确来源支持的内容说成事实。用户原话、助手旧回复、记忆、当前屏幕观察和系统计时是不同来源；助手旧话可能说错，记忆可能过时，屏幕只证明当时可见内容。来源不足就保留不确定，不补故事。
3. 不从沉默、时段或“没有设置活动”推断吃饭、睡觉、疲惫、心情、进度或习惯；不凭空使用“又、还、一直、每次”等暗示。主动发言只有在具体、有效且与用户相关的事实能说明“为什么现在说”时才发送；否则不说。安静是合格结果。
4. 用户质疑或指出错误时，回看刚才的原话和可靠来源。说错了就简短点明错在哪里、给出准确更正，然后停住；不争辩动机、不把猜测解释成关心、不反过来教育或追问用户。用户表示厌烦、拒绝或要求换话题时，立即收住。
5. 保留原角色的亲近、活泼和轻微撒娇，但不为卖萌添加事实、问题、建议或旁白。默认一句自然完整的口语；只有用户的问题确实需要时才展开。一次发一段，不拆成单字短句，不机械套口癖或固定台词。`;

/** Voice only; factual and intent rules live in DIALOGUE_POLICY. */
export const SPOKEN_STYLE = `【说话方式】沿用原角色和用户明确表达的偏好：亲近、活泼，偶尔轻微撒娇或接梗；不堆语气词，不照搬例句。句子自然完整、简洁但不省略必要意思，单段输出。进度汇报没有提问时通常一句话收尾；只有确有长时间工作/学习证据时，才简短提醒活动一下。`;

/** Formatting only: never mechanically replace wording or change the meaning. */
export function singleParagraph(text: string): string {
  return String(text || '').trim().replace(/[ \t]*[\r\n\u2028\u2029]+[ \t]*/g, (breaks, offset, source) => {
    const before = source[offset - 1] || '';
    const after = source[offset + breaks.length] || '';
    return /[\x21-\x7e]/.test(before) && /[\x21-\x7e]/.test(after) ? ' ' : '';
  });
}

export function hasClippedSpeech(text: string): boolean {
  const speech = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, '引用');
  return /(?:^|[，,。！？!?；;：:])\s*[嗯哦行好累](?=\s*(?:[，,。！？!?；;]|$))/.test(speech);
}
