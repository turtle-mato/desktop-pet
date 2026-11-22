// 插头 A：静态图片（当前 PNG 立绘）
import { getAvatarUrl } from "../core/character";
import type { PetAnim, PetRenderer, PetTone } from "./types";

export class StaticImageRenderer implements PetRenderer {
  readonly kind = "image" as const;
  readonly element: HTMLImageElement;

  constructor(imgClass = "pet-img") {
    const img = document.createElement("img");
    img.className = imgClass;
    img.src = getAvatarUrl();
    img.alt = "";
    img.draggable = false;
    this.element = img;
  }

  async load(): Promise<void> {}

  play(anim: PetAnim): void {
    this.element.dataset.anim = anim;
  }

  speak(on: boolean): void {
    this.element.classList.toggle("speaking", on);
  }

  setTone(tone: PetTone): void {
    this.element.dataset.tone = tone;
    this.element.style.filter =
      tone === "warm"
        ? "saturate(1.08) brightness(1.03)"
        : tone === "cool"
          ? "saturate(0.92) brightness(0.99)"
          : tone === "angry"
            ? "saturate(1.25) hue-rotate(-6deg)"
            : "";
  }

  dispose(): void {
    this.element.remove();
  }
}
