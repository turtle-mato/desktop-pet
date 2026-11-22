// 人格档案（对齐 AstrBot persona 设计）：{id, name, description, system_prompt}
// 多人格可切换；外貌（主题色/立绘）独立于人格
import { KV } from "./storage";
import type { EventBus } from "./bus";
import { baseCharacter } from "./character";
import { TIQUN_MODEL } from '../render/framing';
import type { PetView } from '../render/types';

export interface Persona {
  id: string;
  name: string; // 展示名（也注入 prompt）
  description: string; // 一句话简介
  systemPrompt: string; // 自由文本人设（System Prompt），可含 {{变量}}
  useAutoContext: boolean; // 是否在 prompt 后追加"实时状态"自动注入段
  enforceShort: boolean; // 是否附加"简短口语化、不暴露AI"的系统附注
}

export interface Appearance {
  accentColor: string;
  /** 立绘呈现方式：auto=有 Live2D 模型就用，image=始终用 PNG，live2d=强制 Live2D */
  renderer?: "auto" | "image" | "live2d";
  /** Live2D 模型 model3.json 路径（文件放在 public/live2d/ 下） */
  live2dModel?: string;
  view?: PetView;
  /** 仅首次启用本次用户指定的提裙外观，后续尊重设置面板的选择。 */
  live2dPreset?: string;
}

export const PERSONA_TOKENS: { token: string; label: string; hint: string }[] = [
  { token: "{{time}}", label: "时间", hint: "现在几点、问候语" },
  { token: "{{activity}}", label: "活动", hint: "对方当前在做什么、持续多久" },
  { token: "{{todo}}", label: "待办", hint: "未完成的待办摘要" },
  { token: "{{pomodoro}}", label: "番茄钟", hint: "专注/休息状态" },
  { token: "{{memory}}", label: "记忆", hint: "最近几条长期记忆" },
  { token: "{{name}}", label: "名字", hint: "本档案的名字" },
];

function genId(): string {
  return "p" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// 用 character.json 的旧字段编译一档"默认人格"（老数据不丢）
function seedDefault(): Persona {
  const b = baseCharacter();
  const prompt = [
    `你是${b.name}。${b.backstory}`,
    `性格：${b.personality.traits.join("、")}`,
    `说话风格：${b.speech.style}`,
    `口头禅：${b.speech.catchphrases.join("、")}`,
    `喜欢：${b.speech.likes.join("、")}；不喜欢：${b.speech.dislikes.join("、")}`,
    ``,
    `可用的实时变量：{{time}} {{activity}} {{todo}} {{pomodoro}} {{memory}}（用不到就删掉）`,
  ].join("\n");
  return {
    id: "default",
    name: b.name,
    description: b.greeting || "默认人格（由 character.json 生成）",
    systemPrompt: prompt,
    useAutoContext: true,
    enforceShort: true,
  };
}

export function newPersonaTemplate(name: string): Persona {
  return {
    id: genId(),
    name,
    description: "新的陪伴人格",
    systemPrompt: [
      `你是${name}。在这里写下你的人格设定……`,
      ``,
      `你可以随便写：性格、语气、口头禅、喜欢讨厌、和对方的关系……`,
      `可用的实时变量：{{time}} {{activity}} {{todo}} {{pomodoro}} {{memory}}`,
    ].join("\n"),
    useAutoContext: true,
    enforceShort: true,
  };
}

const STORE_KEY = "store";

/** 没有任何人格档案时的"占位人格"（不落盘、不显示在列表里，只为让程序能正常跑） */
export function fallbackPersona(): Persona {
  return {
    id: "__none__",
    // 名字跟角色卡走（外置 character.json 是"她是谁"的唯一来源），
    // 别在这里硬编码一个名字——以前写死的那个是出厂样例，早就不是她了
    name: baseCharacter().name,
    description: "",
    systemPrompt: "",
    useAutoContext: true,
    enforceShort: true,
  };
}

export class PersonaStore {
  private kv = new KV("personas");
  private items: Persona[] = [];
  private activeId = "";
  private removedSeed = false;

  constructor(private bus: EventBus) {
    const saved = this.kv.get<{ items: Persona[]; activeId: string }>(STORE_KEY, null);
    if (saved && Array.isArray(saved.items)) {
      // 一次性清理：删掉早期版本自动生成的那档默认人格（id = "default"）
      const cleaned = saved.items.filter((p) => p.id !== "default");
      this.removedSeed = cleaned.length !== saved.items.length;
      this.items = cleaned;
      this.activeId = cleaned.some((p) => p.id === saved.activeId)
        ? saved.activeId
        : cleaned[0]?.id ?? "";
      if (this.removedSeed) this.persist(false);
    }
    // 首次运行：人格库从"空"开始（不再自动播种默认人格）
  }

  private persist(emit = true): void {
    this.kv.set(STORE_KEY, { items: this.items, activeId: this.activeId });
    if (emit) this.bus.emit("personas:changed");
  }

  list(): Persona[] {
    return [...this.items];
  }
  get(id: string): Persona | undefined {
    return this.items.find((p) => p.id === id);
  }
  /** 当前人格；库里为空时返回占位人格（不落盘） */
  active(): Persona {
    return this.get(this.activeId) ?? this.items[0] ?? fallbackPersona();
  }
  activeIdOf(): string {
    return this.activeId;
  }

  setActive(id: string): void {
    if (this.get(id)) {
      this.activeId = id;
      this.persist();
    }
  }

  add(p: Persona): void {
    this.items.push(p);
    this.persist();
  }

  update(id: string, patch: Partial<Omit<Persona, "id">>): void {
    const p = this.get(id);
    if (!p) return;
    Object.assign(p, patch);
    this.persist();
  }

  /** 复制一份，返回新档案 id；找不到返回 null */
  duplicate(id: string): string | null {
    const p = this.get(id);
    if (!p) return null;
    const copy: Persona = {
      ...p,
      id: genId(),
      name: p.name + " 副本",
    };
    this.items.push(copy);
    this.persist();
    return copy.id;
  }

  /** 删除人格（含当前激活的、也允许删到空库）；删掉激活项后自动切到剩下的第一个 */
  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length === before) return false;
    if (this.activeId === id) this.activeId = this.items[0]?.id ?? "";
    this.persist();
    return true;
  }
}

export class AppearanceStore {
  private kv = new KV("appearance");
  private value: Appearance;

  constructor(private bus: EventBus) {
    const defaults: Appearance = {
      accentColor: baseCharacter().accentColor,
      renderer: "auto",
      live2dModel: TIQUN_MODEL,
      view: 'full',
    };
    this.value = { ...defaults, ...(this.kv.get<Partial<Appearance>>(STORE_KEY, {}) ?? {}) };
    if (this.value.live2dPreset !== 'tiqun-v2') {
      this.value = { ...this.value, renderer: 'live2d', live2dModel: TIQUN_MODEL, view: 'full', live2dPreset: 'tiqun-v2' };
      this.kv.set(STORE_KEY, this.value);
    }
  }

  get(): Appearance {
    return { ...this.value };
  }

  set(patch: Partial<Appearance>): void {
    this.value = { ...this.value, ...patch };
    this.kv.set(STORE_KEY, this.value);
    this.bus.emit("appearance:changed");
  }
}
