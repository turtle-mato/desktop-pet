# mind-server · 运行说明

> 她的大脑。桌宠、QQ、将来的实体都只是"窗口"，**她住在这里**。

---

## 一、怎么跑起来

### 最省事：双击

```
mind\启动她.bat      ← 启动她（她的思维系统）
mind\打开面板.bat    ← 打开控制台网页（她没在跑会提示你先启动）
```

（首次运行会自动生成 `mind/config.json` 与 `mind/data/` 目录）

### 控制台网页（她的面板）

**http://127.0.0.1:8430/** —— 不用装任何东西，浏览器直接开：

| 标签 | 能干什么 |
| --- | --- |
| 📊 状态 | 版本/记忆条数/空闲判定/待总结队列/回收站；按钮：现在跑一次总结、重建索引、立即备份 |
| 🧬 人格文档 | 直接编辑 `林阅心.md`（保存即生效），并能看到"实际注入了什么人格" |
| 📖 初始记忆 | 15 岁以前的小说体原稿（`docs/设定/初始记忆.md`） |
| 🧩 记忆库 | 检索测试（显示分数与命中原因）、逐条编辑/删除情景记忆 |
| 🗣 哥哥的习惯 | 说法→意思的账本；顶部可「试一句」看她会怎么理解，下可增改删/重建 |
| 📔 日记 | 按日期看/改日记、当日情景与情绪、未完结事务、被丢弃条目、当时原话 |
| ⚙️ 配置 | 常用项表单（空闲分钟、回收站天数、生日/年龄、注入条数），含 🧠 模型、🔎 联网搜索两段 |
| 🗂 原始文件 | 列出所有可编辑文档及路径/大小（含 episodic/emotional 的 jsonl 直改） |

**安全约束**：只允许读写上文列出的**白名单文档**（不接受任意路径）；每次写入前自动备份到
`data/backups/edits/`；`config.json` 保存前校验 JSON；页面 token 由服务端注入，服务只监听 127.0.0.1。

> ⚠️ **改这两个 .bat 时注意**（我踩过的坑）：
> 必须是 **GBK 编码 + CRLF 换行**。
> UTF-8 保存 → cmd 按 GBK 读会把中文当命令执行；LF 换行 → cmd 解析错乱。
> 另外脚本里进出 `node` 前后会切代码页（936 / 65001），两边才都不乱码。

### 命令行

```bash
cd E:\DSH工作区\mind
node server/server.ts
```

启动后会打印：

```
[mind] 她在听：http://127.0.0.1:8430  (v0.1.0-p1, LLM=deepseek)
[mind] 数据目录：mind/data  |  token: 654e29da…（完整值在 mind/config.json）
[mind] 握手文件已写入：…\pet\release\app\mind.json
```

**握手文件**：她会把 `{url, token}` 写进桌宠的外置目录，桌宠启动时读它自动连上 → 你不用手动复制令牌。
（换服务器时改 ⚙️ 设置里的地址与令牌即可。）

### 开机自启（当前是"本机常驻"方案）

计划任务里加一条，登录时运行：

```powershell
# 一次性配置（管理员 PowerShell）
$action  = New-ScheduledTaskAction -Execute "node" -Argument "server\server.ts" -WorkingDirectory "E:\DSH工作区\mind"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "mind-server" -Action $action -Trigger $trigger -RunLevel Limited
```

配套的电源设置：**接电源时不睡眠、合盖不睡眠**（否则"常驻"名不副实）。
不想折腾的话，把它丢进「启动」文件夹：`shell:startup` 里放个指向 `启动她.bat` 的快捷方式。

---

## 二、它每天在干什么

```
你聊天 ──▶ 原始日志落盘（零 LLM 成本）
   │           │
   │           └─▶ 当场说了"我说 X 的意思是 Y" → 立即记进习惯账本（不花 LLM）
   │
次日空闲时 ──▶ 取最老一天 → 机械预处理（去噪/分段）→ LLM 抽取
               │                                   ↓
               │                         证据校验（编造的直接丢弃）
               │                                   ↓
               │              写档案卡 + 情景/情绪入库 + 建索引 + 补向量
               │              （顺带抽取"他解释过的说法"进习惯账本）
               │                                   ↓
               └────────────── 原始记录进回收站（保留 2 天，可还原）
```

**空闲判定**：启动满 5 分钟 && 距上次对话 ≥20 分钟 && 距上次总结 ≥10 分钟。
每次只做一天（老的优先），跨天自动补跑（`refillQueueFromRaw`）。

**回话时注入什么**（按顺序拼进 system prompt）：人格文档 → 世界观 → 当下的时间/日期 →
**哥哥的习惯**（说法→意思，最多 3 条 / 360 字）→ 检索到的记忆（关键词+向量混合打分）。

**她会主动开口**：调度心跳里按配比生成话题，配比 2/3 日常 + ≤1/3 回忆，必须有由头，
同话题 3 天不重复，每天上限 3 次，最小间隔 45 分钟，23:00–07:00 安静；被忽略会降频。

---

## 三、CLI：不开桌宠也能验收

```bash
node server/cli.ts health              # 服务状态
node server/cli.ts say "今天好累"       # 走完整链路说一句（SSE 流式）
node server/cli.ts search "面试"        # 检索记忆（含打分原因）
node server/cli.ts why "面试"           # 为什么想起某条
node server/cli.ts diary 2026-09-09    # 看某天日记与记忆
node server/cli.ts list                # 列出情景/情绪记忆
node server/cli.ts summarize [日期] [--force]   # 手动总结
node server/cli.ts tick                # 跑一次调度心跳
node server/cli.ts state               # 队列/回收站/空闲状态
node server/cli.ts persona             # 人格注入预览 + 当前年龄
node server/cli.ts mock-day 2026-09-09 # 造一天假对话（离线测试）
node server/cli.ts test                # 证据校验自测（编造事件必须被丢弃）
node server/cli.ts handover-key sk-xxx # 把 LLM Key 交给服务端
```

`test` 的预期输出：

```
情景保留 2 条、丢弃 1 条
  ✗ [证据不存在] 「编造事件」引用了不存在的消息 m_fake_9999
✅ 证据校验通过：编造的事件被丢弃、混合证据只保留真实 id
```

---

## 四、HTTP 接口（桌宠/QQ/实体都用这套）

鉴权：`Authorization: Bearer <token>`（token 在 `config.json`；本机默认只监听 127.0.0.1）
CORS：只允许 `127.0.0.1` / `localhost` / `tauri.localhost` 来源
不需要 token 的只有三个：`/`（面板）、`/admin`（面板别名）、`/v1/health`

### 对话与会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 状态（不需要 token） |
| POST | `/v1/message` | 一轮对话，**SSE 流式**；末帧带 `emotion / memory_used / model / ms` |
| GET | `/v1/state` | 运行状态、队列、空闲判定 |
| GET | `/v1/messages/recent` | 最近的原始对话（`limit` / `channel` / `hours`） |
| GET | `/v1/messages?date=` | 某一天的原始对话原文（`limit` 默认 300；记录已进回收站时 `inTrash: true`） |
| GET | `/v1/messages/dates` | 有原始记录或有回收站的日期清单 |
| POST | `/v1/proactive/topic` | 让她想一句主动开口的话（可带 `activity` / `pomodoro` / `todoOpen` 等由头） |

### 人格

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/persona` | 人格注入内容 + 当前年龄 |
| POST | `/v1/persona/reload` | 改完人格文档后热重载 |

### 记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/memory/search?q=` | 检索（含命中原因，便于排查"为什么没想起来"） |
| GET | `/v1/memory/list` | 情景+情绪列表 |
| GET | `/v1/memory/diary?date=` | 某天档案卡 + 当时的原话 |
| GET | `/v1/memory/diaries?n=` | 日记目录 |
| POST | `/v1/memory/edit` | 改记忆条目 / 改日记（标记主人改过） |
| POST | `/v1/memory/forget` | 忘掉某条/某天（进回收站语义） |
| GET | `/v1/memory/trash` | 回收站 |
| POST | `/v1/memory/restore` | 还原某天（重新排队总结） |
| POST | `/v1/memory/reindex` | 重建关键词索引，并顺带补齐向量（模型不在就只做关键词，不报错） |

### 哥哥的习惯（说法→意思）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/habits?q=` | 账本列表（带 `preview` 渲染好的文本）+ `enabled`/`extract` 开关状态 |
| GET | `/v1/habits/try?q=` | 试一句：她会把这句话理解成什么、命中了哪几条 |
| POST | `/v1/habits/add` | 手工补录（`key` ≥2 字 + `meaning` 必填） |
| POST | `/v1/habits/edit` | 改一条 |
| POST | `/v1/habits/forget` | 删一条 |
| POST | `/v1/habits/rebuild` | 重建习惯索引 |

> 写入这个库有三条路：**实时纠正**（他当场说"我说 X 的意思是 Y"，零 LLM）、
> **日总结抽取**（他平时解释过的说法，总结时一起抽）、**面板/接口手工补录**。
> 读只有一处：回话时匹配 → 注入提示词的【哥哥的习惯】段。

### 联网搜索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/search?q=` | 走已配置的供应商（现在接的是 Tavily）；没配 key 会返回明确原因，不静默失败 |

### 运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/job/run` | `{job:"summarize"\|"tick", date?, force?}` 手动补跑 |
| POST | `/v1/backup` | 立即备份，返回备份目录 |
| POST | `/v1/llm/key` | 把 API Key 交给服务端（桌宠设置里有一键按钮） |
| POST | `/v1/llm/test` | 测一条最小请求，验证 Key / 网络 / 模型名 |
| GET/POST | `/v1/config` | 读写配置（GET 会打码 key） |
| GET | `/v1/docs` | 可编辑文档清单（白名单 key + 路径） |
| GET/POST | `/v1/docs/read` `/v1/docs/write` | 按白名单 key 读/写文档，写前自动备份 |

---

## 五、配置（`mind/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` / `host` | 8430 / 127.0.0.1 | 地址 |
| `token` | 首次随机生成 | 前端鉴权 |
| `idleMinutes` | 20 | 多久没聊天算空闲 |
| `startupGraceMinutes` | 5 | 启动后多久才开始考虑总结 |
| `summaryCooldownMinutes` | 10 | 两次总结最小间隔 |
| `trashDays` | 2 | 回收站保留天数（主人定） |
| `minMessages` | 6 | 少于这么多有效消息就不调 LLM（代码兜底也是 6；这条 2026-10-07 从 3 调上来） |
| `minSalience` | 0.4 | 低于这个显著度的片段不进长期记忆 |
| `segmentGapMinutes` | 30 | 话题分段间隔 |
| `retrieve.mode` | `hybrid` | `keyword` / `vector` / `hybrid`（关键词+向量 RRF 融合） |
| `retrieve.topK` / `maxChars` / `halfLifeDays` | 4 / 1400 / 30 | 注入条数、字数预算、时间衰减半衰期 |
| `retrieve.vectorTopK` / `vectorMin` / `rrfK` | 12 / 0.5 / 60 | 向量召回条数、相似度门槛、RRF 平滑常数 |
| `retrieve.assoc` / `assocMin` / `assocMax` | true / 0.55 / 0.9 | L2 联想的开关与相似度区间 |
| `proactive.*` | 见下行 | 每天上限 3、回忆占比 0.33、最小间隔 45 分钟、安静时段 23→7、同话题 3 天不重复 |
| `habits.*` | `enabled` `extract` true / 注入 ≤3 条 / 360 字 / `minScore` 2 | 习惯账本开关与注入预算 |
| `search.*` | `provider` tavily / `maxResults` **5**（本机现填 1）/ 超时 8s | 联网搜索；`auto` 控制要不要自动查 |
| `llm.mode` | deepseek | `deepseek` 或 `mock`（离线自测） |
| `llm.apiKey` | 空 | **Key 只存在服务端**，不下发前端 |
| `llm.thinking` / `summaryThinking` | max / high | 回话与总结各自的 thinking 档位 |
| `persona.birthDate` | null | 填了才会按真实日期长年龄；空则用 `baseAge` |
| `persona.baseAge` | 15 | 兜底年龄 |
| `persona.name` / `userName` | 林阅心 / 周言初 | 她怎么称呼自己和他 |

改完配置**重启服务**生效（或调 `/v1/config`）。

---

## 六、数据布局（可以整体搬走）

```
mind/data/
├── raw/YYYY-MM-DD.jsonl      当天原始对话（临时层，总结后进回收站）
├── digest/YYYY-MM-DD.json    每日档案卡（日记 + 情景 + 情绪 + 未完结 + 丢弃记录）
├── episodic/
│   ├── episodic.jsonl        情景记忆（长期）
│   ├── emotional.jsonl       情绪记忆（长期，挂在情景上）
│   ├── index.json            关键词倒排索引
│   ├── vectors.jsonl         向量（本地嵌入，bge-small-zh-v1.5）
│   ├── habits.jsonl          哥哥的习惯：说法→意思的账本
│   └── habits_index.json     习惯索引
├── trash/                    回收站（2 天后自动删）
├── pending/queue.json        待总结队列 + 失败重试
├── backups/YYYY-MM-DD/       每日备份（另有 backups/edits/ 存面板改档前的快照）
└── state.json                运行状态（最后活动、最后总结、话题去重）
```

> `episodic/` 下的 `*.bak-before*` 是历次改抽取策略前的快照，出问题能拿它对账，
> 平时不用管，攒多了可以手动清。

**搬家到服务器**：拷 `mind/`（含 data）+ 改桌宠设置里的地址 → 完事。

---

## 七、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 桌宠面板显示"她的大脑没连上" | 服务没启动 | 双击 `启动她.bat`；桌宠会自动降级为本地模式 |
| 状态里 `LLM mock` | 环境变量 `MIND_LLM_MODE=mock` 残留 | 清掉该环境变量并重启服务 |
| 一直"没有待总结的日子" | 队列空（今天还没过去 / 已总结完） | `cli.ts state` 看队列；`cli.ts summarize 日期 --force` 强制 |
| 总结失败 | LLM Key 无效 / 网络 | `config.json` 里 `llm.apiKey`；失败会重试且**原文不删** |
| 记忆没被想起来 | 关键词没覆盖 | `cli.ts search "…"` 看命中原因；可手工给记忆补 `keywords`（面板可编辑） |
| 语义相近也想不起来 | 向量没建 / 模型不在 | 面板「重建索引」；`data/episodic/vectors.jsonl` 有内容才说明向量在 |
| 她老是理解错某句话 | 习惯账本里没有这条 | 「🗣 哥哥的习惯」试一句，缺就补一条（或用 `POST /v1/habits/add`） |
| 联网搜索总是失败 | 没配 key / 供应商额度 | 面板 ⚙️ 配置 → 🔎 联网搜索；`/v1/search` 会直接回原因 |
| 回收站里东西没了 | 超过 2 天自动清理 | 按设计；想留久点调 `trashDays` |

---

## 八、当前的边界（还没做的）

**P2（检索增强）已完成**（2026-09-13）：本地嵌入（`vendor/` + `models/bge-small-zh-v1.5`）+ 语义召回 + RRF 融合 + L2 联想（向量邻居/同情绪）+ 主动话题池（配比/由头/去重/限额/被忽略降频）。详见 `../../HANDOFF.md` 第二节。

**另外已落地、但原分阶段计划里没单列的**：
- ✅ 哥哥的习惯账本（实时纠正 + 日总结抽取 + 手工补录三条写入路径，注入限 3 条/360 字）
- ✅ 联网搜索适配层（现在接 Tavily，供应商可换；没配 key 会明确报原因）
- ✅ 主动开口的「由头」输入（活动名/番茄钟/待办数，从桌宠侧传进来）

还没做：

- ❌ **P3 自传体记忆与每周《自我认知周报》**（含带证据的性格特质、版本化 `revision_log`、生日事件）
- ❌ L3「LLM 重排」开关（向量召回已覆盖大部分语义场景，暂缓）
- ❌ 生理心理系统（精力/心情/压力/亲密度）—— 它会成为判断段"危险等级/动作分布"的真实输入
- ❌ 让模型"先判断再回话"的判断段对外显示（桌宠气泡下的💭折叠块 / QQ 单独一条消息）
- ❌ QQ 通道（NapCat）
- ❌ 小说体初始记忆的批量导入器（等你稿子）

这些都在 `docs/设计/记忆系统可行性方案.md` 的分阶段计划里，接口已经预留。

---

## 九、现在到底跑到哪一步（实测记录）

| 项 | 状态 |
| --- | --- |
| 版本 | `0.1.0-p1`（`server.ts` 顶部 `VERSION`） |
| 服务地址 | `http://127.0.0.1:8430`，只监听本机 |
| LLM | `deepseek`，`deepseek-chat`；回话 thinking=max、总结=high |
| 检索 | `hybrid`（关键词 + 向量 RRF），向量已建（`vectors.jsonl` 17 KB） |
| 习惯账本 | 已启用，抽取开启，已有一条记录 |
| 主动开口 | 已启用（3 次/天、45 分钟间隔、23–07 静默） |
| 联网搜索 | 已配 Tavily，每次最多 1 条结果、8 秒超时 |
| 记忆规模 | 情景 3.7 KB / 情绪 1.8 KB / 档案卡 9 天 / 索引 12.7 KB |
| 面板 | 8 个标签：状态 / 人格文档 / 初始记忆 / 记忆库 / 哥哥的习惯 / 日记 / 配置 / 原始文件 |

> 上面的数字会随她继续聊而变化，看实时值请开面板或 `cli.ts health`。
> 这一节只回答一个问题：**2026-10 前后她确实是在这台机器上活着、在用的**。
