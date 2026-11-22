/** 使用物理坐标，可用于负坐标副屏和不同 DPI 的工作区。 */
export function clampMiniPosition(x: number, y: number, width: number, height: number,
  area: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width)))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height)))),
  };
}

type Point = { x: number; y: number };
type Area = Point & { width: number; height: number };
export type MiniPlacement = {
  position: Point;
  anchor: Point;
  preferred: Point;
  width: number;
  height: number;
  scale: number;
  area?: Area;
};

/** Keep the user's drop position. Content refreshes must never pull it back onscreen. */
export function planMiniPlacement(position: Point, anchor: Point, width: number, height: number,
  scale: number, area?: Area, previous?: MiniPlacement): MiniPlacement {
  const moved = !previous || Math.abs(position.x - previous.position.x) > 1
    || Math.abs(position.y - previous.position.y) > 1;
  const preferred = previous && !moved ? previous.preferred : {
    x: position.x + (previous?.anchor.x ?? anchor.x) * scale,
    y: position.y + (previous?.anchor.y ?? anchor.y) * scale,
  };
  const changed = !previous || previous.width !== width || previous.height !== height
    || previous.scale !== scale || Math.abs(previous.anchor.x - anchor.x) > .5
    || Math.abs(previous.anchor.y - anchor.y) > .5
    || ['x', 'y', 'width', 'height'].some(k => area?.[k as keyof Area] !== previous.area?.[k as keyof Area]);
  let next = { ...position };
  if (changed) {
    next = { x: Math.round(preferred.x - anchor.x * scale), y: Math.round(preferred.y - anchor.y * scale) };
    if (area) next = clampMiniPosition(next.x, next.y, Math.round(width * scale), Math.round(height * scale), area);
  }
  // Keep the unclamped anchor: collapsing a panel returns to the original location.
  return { position: next, preferred, anchor, width, height, scale, area };
}
