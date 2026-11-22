import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tsLoader } from './test-utils.mjs';

for (const connected of [true, false]) {
  const events = [];
  const timers = [];
  const unexpected = () => assert.fail('启动不应请求模型或生成本地问候');
  const { ChatEngine } = tsLoader({
    '../core/config': { getSection: (_name, defaults) => defaults },
    '../core/session': { greetingByHour: () => '' },
    '../mind/client': { mindUsable: async () => connected, mindSend: unexpected, mindProactive: unexpected },
    './providers': { chatStream: unexpected },
    './fallback': { localReply: unexpected, topicLine: unexpected },
  }, { setTimeout: callback => timers.push(callback) })(fileURLToPath(new URL('../src/chat/engine.ts', import.meta.url)));
  const engine = new ChatEngine({
    bus: { emit: (name, value) => events.push({ name, ...value }) },
    session: { activity: { label: '' }, minutesOn: () => 0 },
    personas: { active: () => ({ name: '她' }) },
    apiRef: {},
  });
  engine.boot();
  engine.boot();
  assert.equal(timers.length, 0, '启动不能安排延迟问候');
  await Promise.resolve();
  assert.equal(events.length, 0, '启动不能发出新消息');
  assert.equal(engine.history.length, 0);
  engine.restoreRecent([{ role: 'assistant', text: '保留原来的聊天', ts: 1 }]);
  assert.equal(engine.history[0].text, '保留原来的聊天');
  assert.ok(events.filter(e => e.name === 'chat:pet').every(e => e.restore === true));
}
console.log('quiet startup passed: online/offline, repeated boot, no timers or new messages, history restoration preserved');
