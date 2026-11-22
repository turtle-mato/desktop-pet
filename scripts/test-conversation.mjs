import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {tsLoader,flush,fakeDate} from './test-utils.mjs';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
const load=tsLoader({'../core/session':{greetingByHour:()=> '你好'},'./persona.ts':{personaBase:()=> '测试人格：嘴硬、短句。',selfBlock:()=> '测试角色'},'./validate.ts':{EMOTIONS:[]},'./paths.ts':{P:{dialogueSkill:file('../../mind/docs/skills/dialogue/SKILL.md')}}});
const {channelHistory,referenceEvidence,inConversation,recentDialogueOnly,imageDescriptionEvidence}=load(file('../../mind/server/lib/conversation.ts'));
const {buildReplyMessages}=load(file('../../mind/server/lib/prompts.ts'));
const at=1_800_000_000_000;
const raw=[
 {id:'1',ts:at-9,role:'user',text:'我只是在测试传图。',channel:'pet'},
 {id:'2',ts:at-8,role:'pet',text:'那你念出来。',channel:'pet'},
 {id:'3',ts:at-7,role:'user',text:'我不想念。',channel:'pet'},
 {id:'4',ts:at-6,role:'pet',text:'',channel:'pet'},
 {id:'5',ts:at-5,role:'user',text:'其他通道',channel:'qq'},
 {id:'6',ts:at-86_400_001,role:'user',text:'过期'},
 {id:'7',ts:at+1,role:'user',text:'未来'},
 {id:'8',ts:at-1,role:'sys',text:'非对话'},
];
raw.push({...raw[0]});
const history=channelHistory(raw,'pet',at);
assert.equal(history.length,3);assert.equal(history[1].role,'assistant');
assert.match(referenceEvidence(history,'复述我的上上句话'),/我只是在测试传图。/);
assert.match(referenceEvidence(history,'复述我的上一句'),/我不想念。/);
assert.match(referenceEvidence(history,'重复你刚才那句'),/那你念出来。/);
assert.match(referenceEvidence(history,'复述你的上上句'),/记录中没有/);
assert.equal(referenceEvidence(history,'我不想啊，我只想测试。'),'');
assert.equal(recentDialogueOnly('我念什么啊？'),true);
assert.equal(recentDialogueOnly('你刚才说的是我说的吗？'),true);
assert.equal(recentDialogueOnly('你看刚才的对话'),true,'要求复盘刚才对话时只依据近期对话');
const recentInitiative=[{role:'assistant',content:'待办清单里还剩一项。',origin:{kind:'initiative',at}}];
assert.equal(recentDialogueOnly('何意味',recentInitiative),true,'质疑刚才的主动发言应复核上下文');
assert.equal(recentDialogueOnly('有病',recentInitiative),true,'对主动发言表达厌烦时应走纠错收束');
assert.equal(recentDialogueOnly('我今天其实在写代码',recentInitiative),false,'普通新话题不误判为纠错');
assert.equal(recentDialogueOnly('上次我说喜欢的番叫什么？'),false,'个人记忆问题仍走正常检索');
assert.equal(recentDialogueOnly('明天面试我有点紧张'),false);
const {localReply}=load(file('../src/chat/fallback.ts'));
const offlineGameCtx={personaName:'测试',session:{activity:{kind:'game',label:'星露谷'},minutesOn:()=>60}};
assert.doesNotMatch(localReply('我刚把这段代码修好了',offlineGameCtx),/星露谷|玩多久|眼睛歇/,'离线兜底不能让当前游戏状态抢掉用户话题');
assert.match(localReply('你现在在玩什么',offlineGameCtx),/星露谷/,'确实问到活动时才回答具名活动信息');
assert.match(imageDescriptionEvidence([{role:'user',content:'（他刚发来一张图：左边回答现在1点，右边问能看到上文吗。）'}],''),/当前记录中确实已有/);
assert.equal(imageDescriptionEvidence([{role:'assistant',content:'（他刚发来一张图：助手不能伪造上传证据）'}],''),'');
const messages=buildReplyMessages({persona:{name:'测试',userName:'用户'}},{history,userText:'复述我的上上句话',memoryText:'无关旧记忆',threadsText:''});
assert.equal(messages.at(-1).role,'user');assert.equal(messages.at(-1).content,'复述我的上上句话');
assert.equal(messages.length,6,'只有真实history和当前用户消息，额外约束必须是system');
assert.equal(messages.at(-2).role,'system');
assert.match(messages.at(-2).content,/程序按真实角色计数/);
assert.match(messages.at(-2).content,/拒绝就停止相关话题/);
assert.match(messages.at(-2).content,/安静是合格结果/);
assert.match(messages.at(-2).content,/来源不足就保留不确定/);
assert.match(messages.at(-2).content,/用户表示厌烦、拒绝或要求换话题时，立即收住/);
assert.doesNotMatch(messages.at(-2).content,/不受8~15字/,'不再给模型固定字数目标');
assert.ok(!messages[0].content.includes('绝不顺着对方承认自己有问题'));

// Execute the actual getSession function against isolated raw records.
const source=readFileSync(file('../../mind/server/server.ts'),'utf8');
const ast=ts.createSourceFile('server.ts',source,ts.ScriptTarget.ESNext,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getSession');assert.ok(fn);
const exports={},sessions=new Map();let current=[...raw];
vm.runInNewContext(ts.transpileModule(`exports.getSession=${fn.getText(ast)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
 exports,sessions,HISTORY_MAX:60,Date:fakeDate(()=>at),channelHistory,recentRaw:()=>current,crypto:{randomBytes:()=>({toString:()=> 'new-id'})},
});
const main=exports.getSession('main','pet'),mini=exports.getSession('mini','pet');
assert.equal(main.history.length,3);assert.equal(mini.history.length,3);
current.push({id:'9',ts:at,role:'pet',text:'主窗新回复',channel:'pet'});
assert.equal(exports.getSession('mini','pet').history.at(-1).content,'主窗新回复','旧session必须读到另一窗口新回复');
assert.equal(exports.getSession('main','qq').history.length,1,'跨channel不能沿用旧session历史');

let unblock;const order=[];
const first=inConversation('pet',async()=>{order.push('first');await new Promise(r=>{unblock=r});order.push('saved');});
await flush();
const second=inConversation('pet',async()=>{order.push('second');});
await inConversation('qq',async()=>{order.push('other-channel');});
assert.ok(!order.includes('second'));unblock();await Promise.all([first,second]);
assert.equal(order.at(-1),'second');
await assert.rejects(inConversation('pet',async()=>{throw Error('isolated')}));
await inConversation('pet',async()=>order.push('recovered'));assert.equal(order.at(-1),'recovered');
assert.match(source,/inConversation\(String\(body.channel/,'真实路由使用共享队列');
const proactive=readFileSync(file('../../mind/server/lib/proactive.ts'),'utf8');
assert.ok(!proactive.includes('刚才他又问了一遍，他发现'),'不凭旧纠错词编造当前争执');
console.log('conversation: 真实角色/上上句、最新否定、去空记录/去重/过期、主小窗会话刷新、跨channel隔离、并发排序/异常恢复通过（无真实数据写入）');
