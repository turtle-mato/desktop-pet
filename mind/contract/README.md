# 心智 API 契约（草案 v0）

> 前端（桌宠 / QQ / 将来的实体）**只通过这里和她对话**。
> 契约原则：**前端不知道人格、不存记忆、不拼 prompt**——它只做"输入转发 + 输出渲染"。

传输：HTTP + WebSocket ｜ 鉴权：`Authorization: Bearer <token>`
消息格式：JSON（流式用 WS 或 SSE）

---

## 端点

### 会话
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/session/open` | `{channel:"pet"\|"qq"\|"voice", user_id}` → `{session_id, greeting}` |
| POST | `/v1/session/close` | `{session_id}` |

### 对话（核心）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/message` | `{session_id, text}` → 流式返回；**最终帧带结构化字段** |

最终帧（前端据此渲染，不必自己分析文本）：
```jsonc
{
  "text": "……（回复正文）",
  "emotion": "失落",           // 本轮她的情绪（用于表情/动作）
  "mood": "低落",              // 当前心境（持续状态）
  "motion": "shake",           // 建议动作：Idle/Blink/Nod/Shake（对齐 Live2D 动作组）
  "speak": true,               // 是否驱动口型
  "memory_used": ["ep_20260910_01"],   // 用到了哪些记忆（可展示"为什么想起这个"）
  "proactive": false,          // 是否是她主动发起
  "channel": "pet"
}
```

### 状态
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/state` | `{mood, energy, stress, closeness, activity, last_seen}` |
| WS | `/v1/stream` | 订阅：主动消息、状态变化、情绪变化、任务完成通知 |

### 记忆（面板 + 你的手动管理）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/memory/search?q=&k=` | 检索（返回分数与命中原因） |
| GET | `/v1/memory/recent?days=` | 近期情景/情绪 |
| GET | `/v1/memory/diary?date=` | 当日日记 |
| POST | `/v1/memory/forget` | `{ids\|date}` → 进回收站（可反悔） |
| GET | `/v1/memory/export` | 全量导出（备份/迁移） |

### 人格
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/persona` | 人格文档 + 自传体（自传体只读） |
| POST | `/v1/persona/reload` | 主人改完文档后热重载（无需重启） |

### 运维
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/job/run` | `{job:"daily_digest"\|"autobiography", date?}` 手动补跑 |
| GET | `/v1/health` | `{ok, version, memory_count, uptime}` |

---

## 前端实现要求

1. **离线降级**：mind 不可达时用本地缓存人设说两句话，并让"她"表现成"刚睡醒/有点懵"（而不是报错）
2. **结构化优先**：情绪/动作一律用返回字段，不要前端自己猜
3. **多窗口**：同一 `user_id` 可开多个 `session_id`；记忆是共享的，会话是隔离的
4. **流式显示**：先出字（可带"嗯…"这类即时反馈），后接正文，别等整段生成

## 待定项（实现前拍板）

- [ ] 同用户多窗口并发策略：排队 / 抢占前台 / 各自独立人格状态（当前建议：排队）
- [ ] `motion` 取值表按各窗口能力协商（Live2D 动作组 / QQ 无 / 实体舵机）
- [ ] 主动消息的投递优先级与免打扰时段
- [ ] 群聊场景的隐私规则（哪些记忆不得在群里提）
