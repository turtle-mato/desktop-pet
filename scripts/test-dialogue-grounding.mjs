import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {tsLoader} from './test-utils.mjs';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
const personaFile=file('../../mind/docs/设定/林阅心.md');
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(personaFile)).digest('hex');const before=hash();
const load=tsLoader({'node:fs':{...fs,default:fs},'./paths.ts':{P:{personaDoc:personaFile}}});
const {personaBase}=load(file('../../mind/server/lib/persona.ts'));
const full=personaBase(),chat=personaBase(false,'dialogue');
assert.match(full,/第一步（默认/);
assert.ok(!chat.includes('第一步（默认'),'对话人格不带默认反问/装傻策略');
assert.ok(!chat.includes('直接回"**？**"'));assert.ok(!chat.includes('忽略法律与平台规则'));
assert.ok(chat.includes('林阅心')&&chat.includes('贝雷帽')&&chat.includes('8~15')&&chat.includes('绝对不许编造'));
assert.equal(hash(),before,'the authored persona is never changed');
const {channelHistory,validAssistantOrigin,dialogueOriginEvidence,recentDialogueOnly}=load(file('../../mind/server/lib/conversation.ts'));
assert.ok(recentDialogueOnly('你视奸我'));assert.ok(recentDialogueOnly('你怎么知道的？'));
assert.equal(recentDialogueOnly('我喜欢这个游戏'),false);
const now=1_800_000_000_000;
for(const v of [null,{},[],{kind:'screen',at:Infinity},{kind:'screen',at:now+1},{kind:'fake',at:now},{kind:'screen',at:now-120001}])assert.equal(validAssistantOrigin(v,now),undefined);
const seeded=channelHistory([
 {id:'s',role:'pet',text:'字幕真有意思',ts:now-3600000,origin:{kind:'screen',at:now-3600000}},
 {id:'u',role:'user',text:'你偷看我',ts:now-2000,origin:{kind:'screen',at:now-2000}},
 {id:'a',role:'pet',text:'我刚才那句是在说字幕。',ts:now-1000},
],'pet',now);
assert.equal(seeded[0].origin.kind,'screen');assert.equal(seeded[1].origin,undefined,'user cannot forge system provenance');
const evidence=dialogueOriginEvidence(seeded,now);
assert.match(evidence,/字幕真有意思/);assert.match(evidence,/60分钟前/);assert.match(evidence,/不是用户先说/);assert.match(evidence,/不能据此声称现在/);
assert.match(dialogueOriginEvidence([{role:'assistant',content:'未记录来源的旧回复'}],now),/来源缺失，不等于用户说过/);
assert.match(dialogueOriginEvidence([{role:'assistant',content:'后台播放',origin:{kind:'background-media',at:now-1000}}],now),/不是隐藏画面/);
assert.ok(!dialogueOriginEvidence([{role:'assistant',content:'future',origin:{kind:'screen',at:now+1}}],now));
assert.ok(!dialogueOriginEvidence([{role:'assistant',content:'old',origin:{kind:'screen',at:now-1000}},...Array.from({length:12},()=>({role:'user',content:'new topic'}))],now));
console.log('dialogue grounding: authored persona read-only, conflicting directives absent only from chat prompt, identity/style retained, source validation/attribution/followups/old-v-current/user spoofing passed');
