import type { PetView } from './types';

export const TIQUN_MODEL = '/live2d/tiqun-v2/rig-input.model3.json';

/** 与小样相同的原画坐标；不依据当前动作的包围盒缩放，防止画面抖动。 */
export function tiqunFrame(view: PetView, w: number, h: number, modelWidth: number, modelHeight: number) {
  const [x, y, cw, ch] = view === 'upper' ? [590, 0, 1280, 1600] : [300, 0, 1800, 3259];
  const sx = modelWidth / 2217, sy = modelHeight / 3259;
  const scale = Math.min(w * .95 / (cw * sx), h * .95 / (ch * sy));
  const px = w / 2 - (x + cw / 2) * sx * scale, py = h / 2 - (y + ch / 2) * sy * scale;
  return { scale, x: px, y: py, bottom: py + (y + ch) * sy * scale,
    faceX: px + 1160 * sx * scale, faceY: py + 590 * sy * scale };
}
