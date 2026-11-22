// Small, local line icons share the interface text color.
const paths = {
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6m-3 0v3m7 1 1.5-1.5"/>',
  todo: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M8 10l1 1 2-2m2 1h3m-8 6 1 1 2-2m2 1h3"/>',
  persona: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  memory: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5Z"/>',
  settings: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  compact: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14 8h3v3m0-3-5 5"/>',
  expand: '<path d="M8 3H3v5m0-5 6 6m7 12h5v-5m0 5-6-6"/>',
  minimize: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pin: '<path d="m9 3 6 0-1 5 4 4v2H6v-2l4-4-1-5Zm3 11v7"/>',
  unpin: '<path d="m9 3 6 0-1 5 4 4v2h-4m-4 0H6v-2l2-2m4 5v6M3 3l18 18"/>',
  hide: '<path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M12 3v11m-4-4 4 4 4-4"/>',
} as const;
export type IconName = keyof typeof paths;

export function setButtonIcon(element: HTMLElement, name: IconName, label: string): HTMLElement {
  element.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
  element.setAttribute('aria-label', label);
  element.title = label;
  return element;
}
