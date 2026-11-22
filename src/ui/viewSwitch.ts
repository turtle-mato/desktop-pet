import { h, button } from './dom';
import type { AppearanceStore } from '../core/persona';
import type { EventBus } from '../core/bus';
import type { PetRenderer, PetView } from '../render/types';

export function createViewSwitch(appearance: AppearanceStore, bus: EventBus) {
  let renderer: PetRenderer | undefined;
  const element = h('div', { class: 'pet-view-switch', role: 'group', 'aria-label': '角色显示范围' });
  const buttons = (['full', 'upper'] as PetView[]).map(view => {
    const b = button(view === 'full' ? '全身' : '上半身', 'pet-view-btn', () => appearance.set({ view }));
    b.setAttribute('type', 'button');
    b.dataset.view = view;
    element.appendChild(b);
    return b;
  });
  // 切视角不触发角色拖动、聊天展开或舞台高度调整。
  for (const event of ['pointerdown', 'mousedown', 'mouseup', 'click']) element.addEventListener(event, e => e.stopPropagation());
  const sync = () => {
    const view = appearance.get().view === 'upper' ? 'upper' : 'full';
    buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    renderer?.setView?.(view);
  };
  bus.on('appearance:changed', sync);
  sync();
  element.hidden = true;
  return { element, attach(r: PetRenderer) { renderer = r; element.hidden = !r.setView; sync(); } };
}
