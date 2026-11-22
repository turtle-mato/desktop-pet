// 外观适配器统一接口：上层只发"意图"，不关心是图片还是 Live2D
export type PetAnim = "idle" | "happy" | "sad" | "sleepy" | "angry" | "tossed" | "blink";
export type PetTone = "neutral" | "warm" | "cool" | "angry";
export type PetView = "full" | "upper";
import type { AvatarAction } from '../../../mind/server/lib/avatarProtocol';

export interface PetRenderer {
  readonly kind: "image" | "live2d";
  /** 挂到舞台里的元素 */
  readonly element: HTMLElement;
  load(): Promise<void>;
  play(anim: PetAnim): void;
  speak(on: boolean): void;
  setTone(tone: PetTone): void;
  setView?(view: PetView): void;
  avatarState?(): Record<string, unknown>;
  avatarAct?(action: AvatarAction): boolean;
  captureAvatar?(): string | null;
  dispose(): void;
}
