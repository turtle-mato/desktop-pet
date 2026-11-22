import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tsLoader, flush } from './test-utils.mjs';

const { planMiniPlacement } = tsLoader()(fileURLToPath(new URL('../src/ui/miniGeometry.ts', import.meta.url)));
for (const scale of [1, 1.25, 1.5, 2]) {
  const area = { x: -1920, y: -200, width: 1920, height: 1080 };
  const anchor = { x: 176, y: 396 };
  const closed = { width: 352, height: 468 };
  for (const drop of [{ x: -1960, y: -240 }, { x: -250, y: -240 },
    { x: -1960, y: 700 }, { x: -250, y: 700 }]) {
    let state = planMiniPlacement({ x: -1500, y: 0 }, anchor, closed.width, closed.height, scale, area);
    // User can drop the transparent margins outside any workarea edge.
    state = planMiniPlacement(drop, anchor, closed.width, closed.height, scale, area, state);
    assert.deepEqual(JSON.parse(JSON.stringify(state.position)), drop);
    for (let i = 0; i < 30; i++) {
      state = planMiniPlacement(state.position, anchor, closed.width, closed.height, scale, area, state);
      assert.deepEqual(JSON.parse(JSON.stringify(state.position)), drop, 'unchanged refresh must not clamp a manual drop');
    }
  }
  // Repeated bubble/chat expansion at the right/bottom must not accumulate drift.
  let state = planMiniPlacement({ x: -Math.round(closed.width * scale), y: 880 - Math.round(closed.height * scale) },
    anchor, closed.width, closed.height, scale, area);
  const original = { ...state.position };
  for (let i = 0; i < 20; i++) {
    state = planMiniPlacement(state.position, { x: 208, y: 496 }, 416, 750, scale, area, state);
    state = planMiniPlacement(state.position, anchor, closed.width, closed.height, scale, area, state);
    assert.deepEqual(JSON.parse(JSON.stringify(state.position)), original, 'expand/collapse must restore the unclamped anchor');
  }
}
console.log('mini geometry: four edges, negative monitor, fractional DPI, repeated fits and reversible expansion passed');

// Exercise actual desktop event handlers, including native drag consuming mouseup.
const windowEvents = new Map(), timers = new Map(); let nextTimer = 0;
const classes = new Set(['chat-off']);
const style = { width: '', setProperty() {} };
const chat = { offsetHeight: 100 };
const bubble = { hidden: true, querySelector: () => null };
const stageEvents = new Map();
const stage = {
  offsetHeight: 348, offsetWidth: 240,
  querySelector: s => s === '.mini-canvas-wrap' ? {} : null,
  getBoundingClientRect: () => ({ x: parseFloat(style.width) / 2 - 120, y: 48, width: 240, height: 348 }),
  getClientRects: () => [1],
  addEventListener: (name, fn) => stageEvents.set(name, fn),
};
const wrap = { style,
  classList: { contains: c => classes.has(c), toggle: c => classes.has(c) ? classes.delete(c) : classes.add(c) },
  querySelector: s => ({ '.mini-chat': chat, '.mini-bubble': bubble })[s] ?? null,
  querySelectorAll: () => [],
};
const tools = { append() {}, querySelectorAll: () => [] };
let position = { x: 1000, y: 400 }, size = { width: 352, height: 468 }, writes = [], dragCount = 0, focus;
const win = { label: 'mini',
  outerPosition: async () => ({ ...position }), outerSize: async () => ({ ...size }), scaleFactor: async () => 1,
  setSize: async v => { size = { width: v.width, height: v.height }; writes.push('size'); },
  setPosition: async v => { position = { x: v.x, y: v.y }; writes.push('position'); },
  startDragging: async () => { dragCount++; }, onFocusChanged: fn => { focus = fn; return Promise.resolve(); },
};
const globals = {
  console: { ...console, warn: (...args) => { throw new Error(String(args[1] || args[0])); } },
  window: { __TAURI_INTERNALS__: {}, addEventListener: (name, fn) => windowEvents.set(name, fn) },
  document: { body: { classList: { add() {} } }, documentElement: { classList: { add() {} } },
    querySelector: s => ({ '.mini-wrap': wrap, '.mini-stage': stage, '.mini-tools': tools })[s],
    createElement: () => ({ classList: { toggle() {} }, addEventListener() {}, setAttribute() {} }),
  },
  getComputedStyle: el => el === wrap ? { getPropertyValue: k => ({ '--mini-char-w': '200', '--mini-canvas-pad': '48' })[k] || '' }
    : { paddingLeft: '20', paddingRight: '20', marginTop: '0', marginBottom: '0' },
  ResizeObserver: class { observe() {} },
  requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
  setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
};
const { initDesktopHooks } = tsLoader({
  '@tauri-apps/api/core': { invoke: async name => name === 'win_ping' ? 'pong' : null },
  '@tauri-apps/api/event': { listen: async () => {} },
  '@tauri-apps/api/window': { getCurrentWindow: () => win,
    LogicalSize: class { constructor(width, height) { Object.assign(this, { width, height }); } },
    PhysicalPosition: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    currentMonitor: async () => ({ workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } }),
  },
}, globals)(fileURLToPath(new URL('../src/desktop.ts', import.meta.url)));
await initDesktopHooks();
windowEvents.get('pet:renderer-ready')(); await flush();
assert.equal(writes.length, 0, 'already fitted native window must not be resized or moved');
for (const drop of [{ x: -40, y: 400 }, { x: 1650, y: 700 }]) {
  position = drop;
  for (let i = 0; i < 20; i++) { windowEvents.get('pet:screen-layout')(); await flush(); }
  assert.equal(writes.length, 0, 'screen updates must leave the dropped edge position alone');
  assert.deepEqual(position, drop);
}
stageEvents.get('mousedown')({ button: 0, clientX: 100, clientY: 150, target: { closest: () => null } });
windowEvents.get('mousemove')({ clientX: 120, clientY: 160 });
assert.equal(dragCount, 1);
classes.delete('chat-off'); // A queued content change during native dragging.
windowEvents.get('pet:screen-layout')(); await flush();
assert.equal(writes.length, 0, 'layout must not fight native dragging');
position = { x: 1500, y: 500 };
windowEvents.get('pet:cursor')({ detail: { leftDown: false } });
assert.ok(timers.size);
for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
await flush();
assert.ok(writes.includes('size'), 'native release without mouseup must resume the pending layout');
writes = [];
for (let i = 0; i < 20; i++) { windowEvents.get('pet:screen-layout')(); await flush(); }
assert.equal(writes.length, 0, 'settled expanded window must stay still');
focus({ payload: true });
for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
await flush(); assert.equal(writes.length, 0, 'focus must not move a fitted window');
console.log('mini desktop: real handlers, zero redundant native writes, edge drops, drag deferral/release, focus stability passed');
