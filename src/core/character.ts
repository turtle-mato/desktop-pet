// 角色卡：名字 / 人设 / 外观 —— 全部从外部文件读取（app/assets/character/character.json）
// 文件是"出厂默认"，应用内修改以 overrides 存本地，优先于文件；改文件刷新即生效
import { KV } from "./storage";
import { assetUrl } from "./env";

const CARD_PATH = "/assets/character/character.json";
const AVATAR_PATH = "/assets/character/avatar.png";

let fileCard: Partial<CharacterCard> | null = null;

/** 启动时读取外置角色卡文件（失败则用内置默认值） */
export async function primeCharacterFile(): Promise<void> {
  try {
    const r = await fetch(assetUrl(CARD_PATH), { cache: "no-store" });
    if (r.ok) fileCard = (await r.json()) as Partial<CharacterCard>;
  } catch {
    fileCard = null;
  }
}

export interface CharacterCard {
  name: string;
  nicknames: string[];
  pronoun: string;
  birthday?: string;
  greeting?: string;
  personality: {
    traits: string[];
    activity: number; // 0-100
    clinginess: number;
    tsundere: number;
    bravery: number;
  };
  speech: {
    style: string;
    catchphrases: string[];
    likes: string[];
    dislikes: string[];
  };
  backstory: string;
  accentColor: string;
}

export type CardPatch = Partial<CharacterCard> & {
  personality?: Partial<CharacterCard["personality"]>;
  speech?: Partial<CharacterCard["speech"]>;
};

export const DEFAULT_CARD: CharacterCard = {
  name: "林阅心",
  nicknames: ["阅心"],
  pronoun: "她",
  birthday: "7-23",
  greeting: "……回来了？",
  personality: { traits: ["腹黑", "三无", "毒舌", "极端依赖哥哥"], activity: 60, clinginess: 95, tsundere: 40, bravery: 25 },
  speech: {
    style: "三无短句，平均 8~15 字；平淡，偶尔一句噎人；句尾偶尔带「~」",
    catchphrases: ["？", "不懂"],
    likes: ["上网", "二次元", "哥在身边"],
    dislikes: ["一个人待着", "别人分走哥的注意力"],
  },
  backstory: "林深夫妇的女儿，父母去世后被周民、林浅收养，和哥哥周言初没有血缘关系。父母常年不在家，吃穿住都是哥哥照顾。",
  accentColor: "#4d6bfe",
};

const overridesKV = new KV("char");

/** 文件里的出厂默认（不带应用内修改） */
export function baseCharacter(): CharacterCard {
  const raw = (fileCard ?? {}) as Partial<CharacterCard>;
  return {
    ...DEFAULT_CARD,
    ...raw,
    personality: { ...DEFAULT_CARD.personality, ...(raw.personality ?? {}) },
    speech: { ...DEFAULT_CARD.speech, ...(raw.speech ?? {}) },
  };
}

/** 把 patch 合并进 target（原地修改，undefined 的字段不覆盖），保持所有引用对象同步 */
export function mergeIntoCard(target: CharacterCard, patch: CardPatch): void {
  for (const k of ["name", "pronoun", "birthday", "greeting", "backstory", "accentColor"] as const) {
    if (patch[k] !== undefined) (target as any)[k] = patch[k];
  }
  if (patch.nicknames) target.nicknames = patch.nicknames;
  if (patch.personality) {
    for (const k of ["traits", "activity", "clinginess", "tsundere", "bravery"] as const) {
      if (patch.personality[k] !== undefined) (target.personality as any)[k] = patch.personality[k];
    }
  }
  if (patch.speech) {
    for (const k of ["style", "catchphrases", "likes", "dislikes"] as const) {
      if (patch.speech[k] !== undefined) (target.speech as any)[k] = patch.speech[k];
    }
  }
}

export function readOverrides(): CardPatch | null {
  return overridesKV.get<CardPatch>("overrides", null);
}

export function writeOverrides(patch: CardPatch): void {
  overridesKV.set("overrides", patch);
}

export function clearOverrides(): void {
  overridesKV.remove("overrides");
}

/** 加载角色卡：出厂默认(文件) <- 应用内修改(本地存储) */
export function loadCard(): CharacterCard {
  const base = baseCharacter();
  const ov = readOverrides();
  if (ov) mergeIntoCard(base, ov);
  return base;
}

export function getAvatarUrl(): string {
  return assetUrl(AVATAR_PATH);
}
