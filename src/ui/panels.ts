// 侧滑面板：待办 / 番茄钟 / 人格管理 / 记忆 / 设置
import { h, clear, button } from "./dom";
import { createScreenToggle } from "./screenToggle";
import type { EventBus } from "../core/bus";
import type { ChatEngine } from "../chat/engine";
import type { PersonaStore, AppearanceStore } from "../core/persona";
import { PERSONA_TOKENS, newPersonaTemplate } from "../core/persona";
import { getSection, setSection, resetSection } from "../core/config";
import { hasLive2DCore, modelExists } from "../render/live2d";
import {
  mindHealth, mindDiaries, mindDiary, mindList, mindTrash, mindRestore, mindForget,
  mindEditEpisode, mindEditDiary, mindRunJob, mindCfg, setMindCfg, handoverKey, MIND_DEFAULTS,
  mindScreenDay,
} from "../mind/client";
import { invoke } from "@tauri-apps/api/core";
import type { TodoItem } from "../types";

export interface PanelDeps {
  bus: EventBus;
  engine: ChatEngine;
  api: Record<string, any>;
  personas: PersonaStore;
  appearance: AppearanceStore;
}

export function createPanelHost(deps: PanelDeps) {
  const { bus, engine, api, personas, appearance } = deps;
  const overlay = h("div", { class: "panel-overlay" });
  const box = h("div", { class: "panel-box" });
  const head = h("div", { class: "panel-head" });
  const body = h("div", { class: "panel-body" });
  const closeBtn = button("✕", "btn subtle", hide);
  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);

  const builders: Record<string, { title: string; build: (container: HTMLElement) => void }> = {
    todo: { title: "待办清单", build: buildTodo },
    pomodoro: { title: "番茄钟", build: buildPomodoro },
    persona: { title: "人格管理", build: buildPersonas },
    memory: { title: "记忆", build: buildMemory },
    settings: { title: "设置", build: buildSettings },
  };

  // 人格面板的"正在编辑"档案 id（跨重绘保持）
  let personaSel: string | null = null;

  function open(name: string) {
    const b = builders[name];
    if (!b) return;
    clear(head);
    head.appendChild(h("span", { class: "panel-title" }, b.title));
    head.appendChild(closeBtn);
    clear(body);
    b.build(body);
    overlay.classList.add("open");
  }
  function hide() {
    overlay.classList.remove("open");
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });

  // ---------- 待办 ----------
  function buildTodo(container: HTMLElement) {
    const apiT = api.todo;
    if (!apiT) return void (container.appendChild(h("div", {}, "待办插件未加载")));

    const listEl = h("div", { class: "todo-list" });
    const render = () => {
      clear(listEl);
      const items: TodoItem[] = apiT.list() || [];
      if (!items.length) {
        listEl.appendChild(h("div", { class: "empty" }, "还没有待办，加一条吧～"));
        return;
      }
      for (const it of items) {
        const row = h("div", { class: "todo-row" + (it.done ? " done" : "") }, [
          h("input", { type: "checkbox", checked: it.done, onclick: () => apiT.toggle(it.id) }),
          h("span", { class: "todo-text" }, it.text + (it.due ? `（${it.due}）` : "")),
          button("删", "btn ghost", () => apiT.remove(it.id)),
        ]);
        listEl.appendChild(row);
      }
    };
    const textIn = h("input", { class: "inp", placeholder: "要做什么？" }) as HTMLInputElement;
    const dueIn = h("input", { class: "inp", placeholder: "截止(可选)" }) as HTMLInputElement;
    const add = () => {
      if (textIn.value.trim()) {
        apiT.add(textIn.value.trim(), dueIn.value.trim() || undefined);
        textIn.value = "";
        dueIn.value = "";
      }
    };
    textIn.addEventListener("keydown", (e) => e.key === "Enter" && add());

    container.appendChild(h("div", { class: "panel-row" }, [textIn, dueIn, button("添加", "btn primary", add)]));
    container.appendChild(listEl);
    container.appendChild(h("div", { class: "panel-foot" }, button("清除已完成", "btn ghost", () => apiT.clearDone?.())));

    bus.on("todo:changed", render);
    render();
  }

  // ---------- 番茄钟 ----------
  function buildPomodoro(container: HTMLElement) {
    const apiP = api.pomodoro;
    if (!apiP) return void (container.appendChild(h("div", {}, "番茄钟插件未加载")));

    const cfg = getSection("pomodoro", { focusMin: 25, breakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4 });
    const timeEl = h("div", { class: "pomo-time" }, "未开始");
    const infoEl = h("div", { class: "muted" }, "");
    const render = () => {
      const s = apiP.snapshot();
      if (s.phase === "idle") {
        timeEl.textContent = "未开始";
        infoEl.textContent = `专注 ${cfg.focusMin} 分 / 短休 ${cfg.breakMin} 分 / 已完成 ${s.cycles} 个番茄`;
      } else {
        const remain = Math.ceil(s.remainingMs / 60000);
        timeEl.textContent = `${s.phase === "focus" ? "🍅 专注中" : "☕ 休息中"} · 剩余 ${remain} 分钟`;
        infoEl.textContent = `已完成 ${s.cycles} 个番茄`;
      }
    };
    container.appendChild(
      h("div", { class: "pomo-ctrl" }, [
        button("开始专注", "btn primary", () => apiP.startFocus()),
        button("开始休息", "btn", () => apiP.startBreak()),
        button("停止", "btn ghost", () => apiP.stop()),
      ]),
    );
    container.appendChild(timeEl);
    container.appendChild(infoEl);

    bus.on("pomodoro:changed", render);
    render();
  }

  // ---------- 人格管理（对齐 AstrBot persona） ----------
  function buildPersonas(container: HTMLElement) {
    let selId = personaSel && personas.get(personaSel) ? personaSel : personas.activeIdOf();
    const msg = h("div", { class: "muted" }, "");
    const rerender = () => {
      personaSel = selId;
      clear(container);
      buildPersonas(container);
    };

    const active = personas.active();
    const list = h("div", { class: "persona-list" });
    for (const p of personas.list()) {
      const isActive = p.id === active.id;
      const isSel = p.id === selId;
      const row = h(
        "div",
        {
          class: "persona-row" + (isSel ? " sel" : "") + (isActive ? " active" : ""),
          onclick: () => {
            selId = p.id;
            rerender();
          },
        },
        [
          h("span", {}, p.name + (isActive ? "（当前）" : "")),
          h("span", { class: "muted" }, p.description.slice(0, 18)),
        ],
      );
      list.appendChild(row);
    }

    container.appendChild(h("div", { class: "sec" }, "人格档案"));
    if (!personas.list().length) {
      container.appendChild(
        h("div", { class: "empty" }, "人格库是空的——点下面的「➕ 新建」写下属于你的角色吧。"),
      );
    }
    container.appendChild(list);
    container.appendChild(h("div", { class: "panel-row" }, [
        button("➕ 新建", "btn", () => {
          const np = newPersonaTemplate("新人格");
          personas.add(np);
          selId = np.id;
          rerender();
        }),
        button("⧉ 复制", "btn", () => {
          const nid = personas.duplicate(selId);
          if (nid) {
            selId = nid;
            rerender();
          }
        }),
        button("🗑 删除", "btn ghost", () => {
          const name = personas.get(selId)?.name ?? "";
          const ok = personas.remove(selId);
          if (ok) {
            selId = personas.activeIdOf();
            msg.textContent = name ? `已删除「${name}」` : "已删除";
            rerender();
          } else {
            msg.textContent = "没有可删除的档案（列表已空）";
          }
        }),
        button("⭐ 设为当前", "btn primary", () => {
          if (!personas.get(selId)) {
            msg.textContent = "先在列表里选一个档案～";
            return;
          }
          personas.setActive(selId);
          msg.textContent = `已切换到「${personas.get(selId)?.name}」`;
        }),
      ]));

    // 库里没有人格时，不显示编辑器（先新建一个）
    const editing = personas.get(selId);
    if (!editing) {
      container.appendChild(msg);
      container.appendChild(
        h("div", { class: "muted" }, "提示：人格文本完全由你掌控；AI 在线模式下整段作为 system prompt。"),
      );
      return;
    }

    const p = editing;
    const nameIn = h("input", { class: "inp", value: p.name }) as HTMLInputElement;
    const descIn = h("input", { class: "inp", value: p.description }) as HTMLInputElement;
    const promptArea = h("textarea", { class: "inp prompt", rows: 12 }) as HTMLTextAreaElement;
    promptArea.value = p.systemPrompt;
    const autoCtxChk = h("input", { type: "checkbox", checked: p.useAutoContext }) as HTMLInputElement;
    const shortChk = h("input", { type: "checkbox", checked: p.enforceShort }) as HTMLInputElement;

    const tokenRow = h("div", { class: "tokens" });
    for (const tk of PERSONA_TOKENS) {
      tokenRow.appendChild(
        h("button", {
          class: "token-chip",
          title: tk.hint,
          onclick: () => {
            promptArea.value += tk.token;
            promptArea.focus();
          },
        }, tk.label),
      );
    }

    const doSave = () => {
      personas.update(selId, {
        name: nameIn.value.trim() || p.name,
        description: descIn.value.trim() || p.description,
        systemPrompt: promptArea.value,
        useAutoContext: autoCtxChk.checked,
        enforceShort: shortChk.checked,
      });
      msg.textContent = `「${nameIn.value.trim() || p.name}」已保存，即时生效 ✓`;
    };

    container.appendChild(h("div", { class: "sec" }, "编辑「" + (p.name || "?") + "」"));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "名字"), nameIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "一句话描述（打招呼用）"), descIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "System Prompt（人设全文，自由编写）"), promptArea]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "点标签插入实时变量"), tokenRow]));
    container.appendChild(h("div", { class: "field-row" }, [
      h("div", { class: "field" }, [h("label", {}, "注入实时状态（时间/待办等）"), autoCtxChk]),
      h("div", { class: "field" }, [h("label", {}, "附加简短口语附注"), shortChk]),
    ]));
    container.appendChild(h("div", { class: "panel-row" }, [button("💾 保存本档案", "btn primary", doSave)]));
    container.appendChild(msg);
    container.appendChild(
      h("div", { class: "muted" }, "说明：人设文本完全由你掌控；AI 在线模式下整段作为 system prompt。本地(无 Key)模式只用到名字与简单规则。"),
    );
  }

  // ---------- 记忆（思维系统 mind 的记忆库：日记 / 情景 / 回收站） ----------
  function buildMemory(container: HTMLElement) {
    let tab: "diary" | "episodic" | "trash" = "diary";

    const statusEl = h("div", { class: "muted mem-status" }, "连接中…");
    const tabRow = h("div", { class: "panel-row mem-tabs" });
    const view = h("div", { class: "mem-view" });

    const mkTab = (id: typeof tab, label: string) => {
      const b = button(label, "btn" + (tab === id ? " primary" : " subtle"), () => {
        tab = id;
        void render();
      });
      return b;
    };

    const refreshStatus = async () => {
      const hs = await mindHealth();
      if (!hs.ok) {
        clear(statusEl);
        statusEl.appendChild(
          h("span", {}, `❌ 她的大脑没连上（${hs.error ?? "未知原因"}）—— 桌宠正用本地模式陪你`),
        );
        statusEl.appendChild(
          button("重试", "btn subtle", () => void refreshStatus()),
        );
        statusEl.appendChild(
          h("div", { class: "muted" }, "启动方式：在 mind 目录执行 node server/server.ts（或双击 启动她.bat）"),
        );
        return;
      }
      const mem = hs.memory ?? { episodes: 0, emotions: 0, digests: 0 };
      statusEl.textContent =
        `✅ mind v${hs.version} ｜ 情景 ${mem.episodes} · 情绪 ${mem.emotions} · 日记 ${mem.digests} 天` +
        ` ｜ ${hs.llm?.mode ?? "?"}${hs.llm?.hasKey ? " ✓" : "（缺 Key）"}` +
        ` ｜ ${hs.persona?.name ?? ""} ${hs.persona?.age ?? ""} 岁`;
    };

    const render = async () => {
      clear(tabRow);
      tabRow.appendChild(mkTab("diary", "📔 日记"));
      tabRow.appendChild(mkTab("episodic", "🧩 情景"));
      tabRow.appendChild(mkTab("trash", "🗑 回收站"));
      tabRow.appendChild(button("总结", "btn subtle", async () => {
        try {
          const r = await mindRunJob("tick");
          alert(r?.tick?.note ? `已触发：${r.tick.note}` : "已触发了总结检查");
          void render();
        } catch (e) {
          alert(`触发失败：${(e as Error).message}`);
        }
      }));
      tabRow.appendChild(button("刷新", "btn subtle", () => void render()));

      clear(view);
      view.appendChild(h("div", { class: "empty" }, "读取中…"));
      try {
        if (tab === "diary") await renderDiary(view);
        else if (tab === "episodic") await renderEpisodic(view, render);
        else await renderTrash(view);
      } catch (e) {
        clear(view);
        view.appendChild(h("div", { class: "empty" }, `读取失败：${(e as Error).message}`));
      }
    };

    container.appendChild(statusEl);
    container.appendChild(tabRow);
    container.appendChild(view);
    container.appendChild(
      h("div", { class: "panel-foot muted" },
        "记忆由思维系统（mind）统一保管：桌宠只是窗口。聊天原始记录会在总结后进回收站，保留 2 天自动删除。"),
    );

    void refreshStatus();
    void render();
  }

  async function renderDiary(view: HTMLElement) {
    clear(view); // 清掉"读取中…"占位
    const list = await mindDiaries(30);
    if (!list?.dates?.length) {
      view.appendChild(h("div", { class: "empty" }, "还没有日记。聊一天，等她空闲时就会写下来。"));
      return;
    }
    const dateSel = h("select", { class: "inp" }) as HTMLSelectElement;
    for (const d of list.dates) {
      const opt = document.createElement("option");
      opt.value = d;
      const meta = list.items.find((x: any) => x.date === d);
      opt.textContent = `${d}${meta ? `（情景 ${meta.episodes} / 情绪 ${meta.emotions}）` : ""}`;
      dateSel.appendChild(opt);
    }
    const date = dateSel.value || list.dates[0];
    const box = h("div", { class: "mem-diary" });
    const load = async () => {
      clear(box);
      box.appendChild(h("div", { class: "empty" }, "读取中…"));
      const d = await mindDiary(dateSel.value);
      clear(box);
      const dig = d?.digest;
      if (!dig) {
        box.appendChild(h("div", { class: "empty" }, "这天还没有档案卡"));
      } else {
        const ta = h("textarea", { class: "inp mem-diary-text", rows: "8" }) as HTMLTextAreaElement;
        ta.value = dig.diary ?? "";
        box.appendChild(ta);
        box.appendChild(
          h("div", { class: "panel-row" }, [
            button("保存日记", "btn primary", async () => {
              await mindEditDiary(dateSel.value, ta.value);
              alert("已保存（标记为你改过，以后归纳以你的版本为准）");
            }),
            h("span", { class: "muted" }, `${dig.model ?? ""}${dig.edited_by === "user" ? " · 你改过" : ""}`),
          ]),
        );
        if (dig.episodes?.length) {
          box.appendChild(h("div", { class: "sec" }, "这天的情景记忆"));
          for (const e of dig.episodes) {
            const em = dig.emotions?.find((m: any) => m.episode_id === e.id);
            box.appendChild(
              h("div", { class: "mem-row" },
                `🧩 ${e.title}${em ? ` · ${em.emotion}` : ""}（重要度 ${e.salience}）\n${e.summary}`),
            );
          }
        }
        if (dig.open_threads?.length) {
          box.appendChild(h("div", { class: "sec" }, "未完结"));
          for (const t of dig.open_threads) box.appendChild(h("div", { class: "mem-row" }, `⏳ ${t.text}`));
        }
        if (dig.dropped?.length) {
          box.appendChild(
            h("div", { class: "sec" }, `被证据校验丢弃 ${dig.dropped.length} 条（防幻觉）`),
          );
          for (const x of dig.dropped) box.appendChild(h("div", { class: "mem-row muted" }, `✗ ${x.detail}`));
        }
        // 原话（回收站里还能看）
        const raw = d?.raw;
        if (raw?.items?.length) {
          const det = h("details", { class: "mem-raw" });
          det.appendChild(h("summary", {}, `当时的原话（${raw.count} 条）`));
          for (const m of raw.items.slice(-40)) {
            det.appendChild(h("div", { class: "mem-row muted" }, `${m.role === "user" ? "哥哥" : "她"}：${m.text}`));
          }
          box.appendChild(det);
        }
      }
    };
    dateSel.addEventListener("change", () => void load());
    view.appendChild(h("div", { class: "field" }, [h("label", {}, "选择日期"), dateSel]));
    view.appendChild(box);
    await load();
  }

  async function renderEpisodic(view: HTMLElement, reload: () => Promise<void>) {
    clear(view);
    const data = await mindList(200);
    if (!data?.items?.length) {
      view.appendChild(h("div", { class: "empty" }, "还没有情景记忆"));
      return;
    }
    for (const e of data.items) {
      const row = h("div", { class: "mem-row mem-edit" });
      const paint = (edit: boolean) => {
        clear(row);
        if (!edit) {
          row.appendChild(
            h("div", {},
              `🧩 [${e.date}] ${e.title}${e.emotion ? ` · ${e.emotion.emotion}` : ""}（重要度 ${e.salience}）\n${e.summary}`),
          );
          const acts = h("div", { class: "panel-row" }, [
            button("编辑", "btn subtle", () => paint(true)),
            button("删除", "btn ghost", async () => {
              if (!confirm(`删掉这条记忆？\n${e.title}`)) return;
              await mindForget({ ids: [e.id] });
              await reload();
            }),
          ]);
          row.appendChild(acts);
          return;
        }
        const titleIn = h("input", { class: "inp", value: e.title }) as HTMLInputElement;
        const sumIn = h("textarea", { class: "inp", rows: "3" }) as HTMLTextAreaElement;
        sumIn.value = e.summary;
        const salIn = h("input", { class: "inp", type: "number", min: "0", max: "1", step: "0.1", value: String(e.salience) }) as HTMLInputElement;
        row.appendChild(h("div", { class: "field" }, [h("label", {}, "标题"), titleIn]));
        row.appendChild(h("div", { class: "field" }, [h("label", {}, "摘要"), sumIn]));
        row.appendChild(h("div", { class: "field" }, [h("label", {}, "重要度"), salIn]));
        row.appendChild(
          h("div", { class: "panel-row" }, [
            button("保存", "btn primary", async () => {
              await mindEditEpisode(e.id, {
                title: titleIn.value.trim(),
                summary: sumIn.value.trim(),
                salience: Number(salIn.value) || 0.5,
              });
              e.title = titleIn.value.trim();
              e.summary = sumIn.value.trim();
              e.salience = Number(salIn.value) || 0.5;
              paint(false);
            }),
            button("取消", "btn subtle", () => paint(false)),
          ]),
        );
      };
      paint(false);
      view.appendChild(row);
    }
  }

  async function renderTrash(view: HTMLElement) {
    clear(view);
    const t = await mindTrash();
    if (!t?.items?.length) {
      view.appendChild(h("div", { class: "empty" }, `回收站是空的（保留 ${t?.keepDays ?? 2} 天后自动删除）`));
      return;
    }
    for (const it of t.items) {
      view.appendChild(
        h("div", { class: "mem-row" }, [
          h("span", {}, `🗑 ${it.date}（${it.sizeKB} KB）`),
          button("还原", "btn subtle", async () => {
            await mindRestore(it.date);
            clear(view);
            await renderTrash(view);
          }),
        ]),
      );
    }
    view.appendChild(h("div", { class: "muted" }, `超过 ${t.keepDays} 天的原始记录会被自动删除；还原后会重新排队，下次空闲重新总结。`));
  }

  // ---------- 设置（AI / 提醒 / 外观） ----------
  function buildSettings(container: HTMLElement) {
    const ai = getSection("ai", { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "", devProxy: true });
    const wellness = getSection("wellness", { workMin: 90, studyMin: 90, gameMin: 60 });
    const todoCfg = getSection("todo", { nagIntervalMin: 30 });

    const keyIn = h("input", { class: "inp", type: "password", value: ai.apiKey || "", placeholder: "API Key（留空=本地回复）" }) as HTMLInputElement;
    const baseIn = h("input", { class: "inp", value: ai.baseUrl || "", placeholder: "API 地址" }) as HTMLInputElement;
    const modelIn = h("input", { class: "inp", value: ai.model || "", placeholder: "模型名" }) as HTMLInputElement;
    const proxyChk = h("input", { type: "checkbox", checked: !!ai.devProxy }) as HTMLInputElement;

    const workIn = numIn(wellness.workMin);
    const studyIn = numIn(wellness.studyMin);
    const gameIn = numIn(wellness.gameMin);
    const nagIn = numIn(todoCfg.nagIntervalMin);

    container.appendChild(h("div", { class: "sec" }, "🤖 AI 对话"));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "API Key"), keyIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "Base URL"), baseIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "模型"), modelIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "开发期走本地代理(解决CORS)"), proxyChk]));
    container.appendChild(button("保存 AI 设置", "btn primary", () => {
      setSection("ai", {
        apiKey: keyIn.value.trim(),
        baseUrl: baseIn.value.trim() || "https://api.deepseek.com",
        model: modelIn.value.trim() || "deepseek-chat",
        devProxy: proxyChk.checked,
      });
      location.reload();
    }));
    container.appendChild(h("div", { class: "muted" }, engine.isAi ? "当前：AI 在线模式" : "当前：本地回复模式（无 Key）"));

    container.appendChild(h("div", { class: "sec" }, "⏱ 提醒阈值（分钟）"));
    container.appendChild(h("div", { class: "field-row" }, [fieldN("工作", workIn), fieldN("学习", studyIn), fieldN("游戏", gameIn)]));
    container.appendChild(h("div", { class: "field-row" }, [fieldN("待办催促间隔", nagIn)]));
    container.appendChild(button("保存提醒设置", "btn primary", () => {
      setSection("wellness", { workMin: nv(workIn), studyMin: nv(studyIn), gameMin: nv(gameIn) });
      setSection("todo", { nagIntervalMin: nv(nagIn) });
      location.reload();
    }));

    // 外观（独立于人格，AstrBot 式"人设与外表分离"）
    container.appendChild(h("div", { class: "sec" }, "界面外观"));
    container.appendChild(h("div", { class: "theme-preview", 'aria-label': '黑白灰界面' }, [
      h('span', { class: 'theme-swatch light' }), h('span', { class: 'theme-swatch gray' }),
      h('span', { class: 'theme-swatch dark' }), h('span', {}, '黑白灰 · 简洁外观'),
    ]));
    container.appendChild(h("div", { class: "muted" }, "界面统一使用黑白灰，立绘保持原色。人格切换在“人格管理”页面。"));

    // 👁 屏幕感知：与 mind 的人格/记忆分开；用户明确开启才采集。
    const screenChk = createScreenToggle(bus, api);
    const screenMsg = h("div", { class: "muted" }, "开启后按活动调整读屏频率，画面分析会产生费用；关闭后停止自动识字、截图及后台活动读取，并清空当前观察。重启记住开关，聊天和手动发图不受影响。只在开启时保存简短画面摘要到 mind/data/screen-days，不存截图、逐字OCR。21:30后会用当天已有摘要自然聊一次（服从安静时段，不额外截图；这次文字生成仍会计费）。已提交请求可能仍计费。");
    container.appendChild(h("div", { class: "sec" }, "👁 屏幕感知"));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "允许桌宠持续查看桌面（可随时关闭）"), screenChk]));
    container.appendChild(screenMsg);
    const dayText = h("div", { class: "muted", style: { whiteSpace: "pre-wrap" } });
    container.appendChild(button("看看今天记住了什么", "btn subtle", async () => {
      dayText.textContent = "正在读取本地日记…";
      try {
        const day = await mindScreenDay();
        dayText.textContent = `${day.date} · ${day.count} 次零散观察\n${day.reflection || day.summary || "今天还没有可靠的读屏摘要，不会凭空编一天的经历。"}`;
      } catch { dayText.textContent = "暂时无法读取日记，请确认 mind 已更新并连接。"; }
    }));
    container.appendChild(dayText);

    container.appendChild(h("div", { class: "sec" }, "💬 主动消息气泡"));
    const bubbleTestStatus = h("div", { class: "muted" }, "切到立绘小窗，显示一条示例消息；不改变主动频率或安静时段设置。");
    const bubbleTestBtn = button("测试主动气泡", "btn subtle", async () => {
      bubbleTestBtn.disabled = true;
      try {
        await invoke("win_show_mini");
        hide();
        engine.sayPet("我在这儿呢～这是主动气泡测试。可以把鼠标放上来慢慢看，也可以点“回复”和我聊天。", "initiative");
      } catch (e) {
        bubbleTestStatus.textContent = `气泡测试未能启动：${(e as Error).message}`;
      } finally {
        bubbleTestBtn.disabled = false;
      }
    }) as HTMLButtonElement;
    bubbleTestBtn.disabled = !(window as any).__TAURI_INTERNALS__;
    container.append(bubbleTestBtn, bubbleTestStatus);

    // 🚀 开机自启动（只有桌面版 exe 有注册表能力）
    const isDesktop = !!(window as any).__TAURI_INTERNALS__;
    container.appendChild(h("div", { class: "sec" }, "🚀 开机自启动"));
    const autoChk = h("input", { type: "checkbox", disabled: !isDesktop }) as HTMLInputElement;
    const autoMsg = h(
      "div",
      { class: "muted" },
      isDesktop ? "读取中…" : "只有桌面版（陪伴桌宠.exe）能设置；浏览器里没有这个能力。",
    );
    if (isDesktop) {
      invoke<any>("autostart_get")
        .then((r) => {
          autoChk.checked = !!r?.enabled;
          autoMsg.textContent = r?.error ? `启动状态读取失败：${r.error}` : r?.windowsDisabled
            ? "Windows 已禁用这个启动项，重新勾选可恢复。"
            : r?.enabled
            ? `已开启：登录 Windows 后自动启动 ${r.exe}`
            : `当前未开启（本 exe：${r?.exe ?? "?"}）`;
        })
        .catch((e) => (autoMsg.textContent = `读取失败：${String(e)}`));
    }
    autoChk.addEventListener("change", async () => {
      try {
        const msg = await invoke<string>("autostart_set", { enabled: autoChk.checked });
        autoMsg.textContent = String(msg);
      } catch (e) {
        autoMsg.textContent = `设置失败：${String(e)}`;
        autoChk.checked = !autoChk.checked; // 失败就退回原状态
      }
    });
    container.appendChild(
      h("div", { class: "field" }, [h("label", {}, "登录 Windows 后自动启动桌宠"), autoChk]),
    );
    container.appendChild(autoMsg);
    container.appendChild(
      h("div", { class: "muted" }, "仅设置桌宠的开机启动；重新勾选也会恢复被 Windows 禁用的桌宠启动项。"),
    );

    // 🧠 思维系统（mind）：人格/记忆/情绪都在她那边，桌宠只是窗口
    const mc = mindCfg();
    const mindChk = h("input", { type: "checkbox", checked: !!mc.enabled }) as HTMLInputElement;
    const mindUrlIn = h("input", { class: "inp", value: mc.url || MIND_DEFAULTS.url }) as HTMLInputElement;
    const mindTokIn = h("input", { class: "inp", type: "password", value: mc.token || "", placeholder: "令牌（本地会自动从 app/mind.json 读）" }) as HTMLInputElement;
    const mindStatusEl = h("div", { class: "muted" }, "检测中…");
    const checkMind = async () => {
      const h2 = await mindHealth();
      mindStatusEl.textContent = h2.ok
        ? `已连上 v${h2.version} · 情景 ${h2.memory?.episodes ?? 0} · 情绪 ${h2.memory?.emotions ?? 0} · 日记 ${h2.memory?.digests ?? 0} 天 · LLM ${h2.llm?.mode}${h2.llm?.hasKey ? "(Key 已配置)" : "(缺 Key)"}`
        : `未连上：${h2.error ?? "未知"}（桌宠会自动降级为本地模式）`;
    };
    void checkMind();

    const mindKeyBtn = button("把 API Key 交给她", "btn subtle", async () => {
      const ai2 = getSection("ai", { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" });
      if (!ai2.apiKey) return void alert("上面「AI 对话」里还没填 API Key");
      try {
        await handoverKey(ai2.apiKey, ai2.baseUrl, ai2.model);
        alert("已交给思维系统（Key 存在 mind/config.json，不再下发到前端）");
        void checkMind();
      } catch (e) {
        alert(`失败：${(e as Error).message}`);
      }
    });

    container.appendChild(h("div", { class: "sec" }, "🧠 思维系统（她的大脑）"));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "启用（关掉=只用本地模式）"), mindChk]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "服务地址"), mindUrlIn]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "令牌"), mindTokIn]));
    const autoStartChk = h("input", { type: "checkbox", checked: mc.autoStart !== false }) as HTMLInputElement;
    container.appendChild(
      h("div", { class: "field" }, [
        h("label", {}, "连不上时自动拉起她的大脑（桌面版；需要 node 在 PATH 里）"),
        autoStartChk,
      ]),
    );
    container.appendChild(
      h("div", { class: "panel-row" }, [
        button("保存", "btn primary", () => {
          setMindCfg({
            enabled: mindChk.checked,
            autoStart: autoStartChk.checked,
            url: mindUrlIn.value.trim() || MIND_DEFAULTS.url,
            token: mindTokIn.value.trim(),
          });
          void checkMind();
        }),
        button("测试连接", "btn subtle", () => void checkMind()),
        mindKeyBtn,
        button("现在总结", "btn subtle", async () => {
          try {
            const r = await mindRunJob("tick");
            alert(r?.tick?.note ?? "已触发");
          } catch (e) {
            alert(`失败：${(e as Error).message}`);
          }
        }),
      ]),
    );
    container.appendChild(mindStatusEl);
    container.appendChild(
      h("div", { class: "muted" },
        "启动她：在 mind 目录运行 node server/server.ts（或双击 启动她.bat）。她不在时桌宠用本地模式，不会崩。"),
    );

    // 🎭 立绘呈现方式（图片 / Live2D 适配器）
    const ap = appearance.get();
    const curRenderer = (ap.renderer as string) || "auto";
    const rendererSel = h("select", { class: "inp" }) as HTMLSelectElement;
    for (const [value, text] of [
      ["auto", "自动（检测到 Live2D 模型就用）"],
      ["image", "图片（当前 PNG 立绘）"],
      ["live2d", "Live2D（强制，缺文件会回退）"],
    ] as [string, string][]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === curRenderer) opt.selected = true;
      rendererSel.appendChild(opt);
    }
    const modelPathIn = h("input", {
      class: "inp",
      value: ap.live2dModel || "/live2d/tiqun-v2/rig-input.model3.json",
      placeholder: "/live2d/tiqun-v2/rig-input.model3.json",
    }) as HTMLInputElement;
    const detectEl = h("div", { class: "muted" }, "检测中…");
    void (async () => {
      const core = await hasLive2DCore();
      const ok = await modelExists(modelPathIn.value.trim() || "/live2d/tiqun-v2/rig-input.model3.json");
      detectEl.textContent = `Cubism Core：${core ? "已就绪 ✅" : "缺失 ❌（放 live2d/core/live2dcubismcore.min.js）"} ｜ 模型文件：${ok ? "已找到 ✅" : "未找到 ❌"}`;
    })();

    container.appendChild(h("div", { class: "sec" }, "🎭 立绘呈现方式"));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "渲染器"), rendererSel]));
    container.appendChild(h("div", { class: "field" }, [h("label", {}, "Live2D 模型路径（model3.json）"), modelPathIn]));
    container.appendChild(
      button("保存呈现方式", "btn primary", () => {
        appearance.set({ renderer: rendererSel.value as any, live2dModel: modelPathIn.value.trim() });
        location.reload();
      }),
    );
    container.appendChild(detectEl);
    container.appendChild(
      h("div", { class: "muted" }, "把 psd2live / Cubism 导出的模型族（model3.json + moc3 + 贴图）放进 app/live2d/ 的某个子目录，路径填 /live2d/<目录>/<文件名>.model3.json 即可；官方 Cubism Core 放 app/live2d/core/。详见 docs/Live2D接入说明.md。"),
    );

    container.appendChild(h("div", { class: "panel-foot" }, button("恢复 AI/提醒默认设置", "btn ghost", () => {
      resetSection("ai");
      location.reload();
    })));
  }

  // ---------- 小工具 ----------
  function numIn(v: any): HTMLInputElement {
    return h("input", { class: "inp num", type: "number", value: v ?? "" }) as HTMLInputElement;
  }
  const nv = (el: HTMLInputElement) => Math.max(1, parseInt(el.value, 10) || 1);
  function fieldN(label: string, el: HTMLInputElement): HTMLElement {
    return h("div", { class: "field" }, [h("label", {}, label), el]);
  }

  return { root: overlay, open, hide };
}
