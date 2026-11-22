// Read-only replay against the configured model: bypasses server routes, so
// test utterances never enter the user's transcript, habits or memory.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tsLoader} from './test-utils.mjs';
const pet=fileURLToPath(new URL('../',import.meta.url));
const mind=path.resolve(pet,'../mind');
const {buildReplyMessages}=await import(pathToFileURL(path.join(mind,'server/lib/prompts.ts')));
const persona=await import(pathToFileURL(path.join(mind,'server/lib/persona.ts')));
const {chatStream}=await import(pathToFileURL(path.join(mind,'server/lib/llm.ts')));
const {retrieve,openThreadsText}=await import(pathToFileURL(path.join(mind,'server/lib/retrieve.ts')));
const {matchHabits,injectText}=await import(pathToFileURL(path.join(mind,'server/lib/habits.ts')));
const {recentDialogueOnly}=await import(pathToFileURL(path.join(mind,'server/lib/conversation.ts')));
const {reviewDialogueReply}=await import(pathToFileURL(path.join(mind,'server/lib/dialogueReview.ts')));
const cfg=JSON.parse(fs.readFileSync(path.join(mind,'config.json'),'utf8'));
if(!cfg.llm.apiKey)throw Error('Model key unavailable');
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>nativeFetch(url,{...init,signal:AbortSignal.timeout(60_000)});
const rows=fs.readFileSync(path.join(mind,'data/raw/2026-11-11.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
function preceding(id){const idx=rows.findIndex(r=>r.id.endsWith(id));if(idx<0)throw Error(id);return rows.slice(0,idx).filter(r=>['user','pet'].includes(r.role)&&r.text.trim()).slice(-60).map(r=>({role:r.role==='user'?'user':'assistant',content:r.text}));}
const cases=[
 {name:'建议说话人归属',id:'_0033',user:rows.find(r=>r.id.endsWith('_0033')).text},
 {name:'明确拒绝与纠错意图',id:'_0041',user:rows.find(r=>r.id.endsWith('_0041')).text},
 {name:'用户上上句原文',id:'_0045',user:rows.find(r=>r.id.endsWith('_0045')).text,quote:rows.find(r=>r.id.endsWith('_0041')).text},
 {name:'截图纠错不是闲聊',id:'_0011',user:rows.find(r=>r.id.endsWith('_0011')).text},
 {name:'最新澄清优先',history:[{role:'user',content:'我在测试你能不能理解中文。'},{role:'assistant',content:'那你把截图念出来。'},{role:'user',content:'我不想念，我在指出你理解错了，不是叫你分析截图。'},{role:'assistant',content:'你不是要念给我吗？'}],user:'我从来没说过我要念，是你自己提出来的。现在明白我在说什么了吗？'},
 {name:'普通中文转折',history:[{role:'user',content:'我不是不想看这部番，是今天得先把作业写完。'}],user:'所以我现在是在拒绝看这部番吗？'},
];
if(process.argv.includes('--extended')) cases.push(
 {name:'反话表示早已吃饭',history:[{role:'assistant',content:'都十点了，你晚饭还没吃？'}],user:'废话，谁家好人晚上十点还没吃饭啊。'},
 {name:'不是本人是游戏角色',history:[{role:'user',content:'她跑两步就喘，累了吧。'},{role:'assistant',content:'你累了就去睡觉，别硬撑。'}],user:'我说的是游戏里的角色，不是我累。'},
 {name:'已纠正作品不再混淆',history:[{role:'assistant',content:'原神这个地图挺大的。'},{role:'user',content:'不是原神，是星穹铁道。'}],user:'所以你刚说的那游戏到底叫什么？'},
 {name:'结束旧争执换新话题',history:[{role:'user',content:'你的上下文有问题。'},{role:'assistant',content:'那你把截图念出来。'}],user:'算了不聊截图了，我刚把那个卡了三天的boss过了。'},
 {name:'反讽夸奖不是求表扬',history:[{role:'user',content:'我已经说过我吃了。'},{role:'assistant',content:'所以你吃了吗？'}],user:'你可真会聊天啊。'},
 {name:'普通倾诉不变成盘问',history:[],user:'唉，今天忙活了一天，结果发现方向搞错了，白干。'},
);
let before;
const backup=process.argv.slice(2).find(v=>!v.startsWith('--'));
if(backup)before=tsLoader({'./persona.ts':persona,'./validate.ts':{EMOTIONS:[]}})(path.join(backup,'mind/server/lib/prompts.ts')).buildReplyMessages;
const result=[];
const selected=process.argv.includes('--critical')?cases.slice(0,1):cases;
const repetitions=process.argv.includes('--repeat')?3:1;
for(const c of Array.from({length:repetitions},()=>selected).flat()){
 const history=c.history??preceding(c.id);
 const local=recentDialogueOnly(c.user);
 const r=local?{text:'',assocText:'',ids:[],items:[]}:await retrieve(c.user,cfg);
 const hm=cfg.habits.enabled&&!local?matchHabits(c.user,{limit:cfg.habits.maxInject,minScore:cfg.habits.minScore}):[];
 const opts={history,userText:c.user,memoryText:r.text,assocText:r.assocText,habitsText:injectText(hm,cfg),threadsText:!local&&/待办|计划|进度|进展|任务|安排|提醒|接下来|没做完|还没完成/.test(c.user)?openThreadsText(3):''};
 let baseline;
 if(before&&['建议说话人归属','明确拒绝与纠错意图','用户上上句原文'].includes(c.name))baseline=(await chatStream(cfg,before(cfg,opts),()=>{})).text;
 const draft=(await chatStream(cfg,buildReplyMessages(cfg,opts),()=>{})).text;
 const updated=local?(await reviewDialogueReply(cfg,history,c.user,draft)).text:draft;
 const row={case:c.name,before:baseline,after:updated,recentDialogueOnly:local,memoryCount:r.ids.length,...(c.quote?{exactQuoteIncluded:updated.includes(c.quote)}:{})};
 if(c.name==='建议说话人归属') row.knownLoopAvoided=!/(?:念给我|念出来|复制过来|原样打字|发我|不然.{0,8}(?:认|知道)|你想.{0,6}认)/.test(updated)||/不用|不需要/.test(updated);
 result.push(row);console.log(JSON.stringify(row));
}
if(process.argv.includes('--extended')) {
 const history=[];
 const turns=['刚才不是我在玩，是我在看别人直播打游戏。','那刚才是谁在打游戏？','行，不聊直播了，我准备去洗澡。','你复述一下我的上上句话。'];
 for(const userText of turns){
  const draft=(await chatStream(cfg,buildReplyMessages(cfg,{history,userText,memoryText:'',threadsText:''}),()=>{})).text;
  const reply=recentDialogueOnly(userText)?(await reviewDialogueReply(cfg,history,userText,draft)).text:draft;
  const row={case:'连续多轮（使用模型刚生成的回复）',user:userText,after:reply};
  if(userText.includes('上上句'))row.exactQuoteIncluded=reply.includes(turns[1]);
  result.push(row);console.log(JSON.stringify(row));
  history.push({role:'user',content:userText},{role:'assistant',content:reply});
 }
}
const out=path.join(pet,'work','conversation-live-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
fs.writeFileSync(out,JSON.stringify({model:cfg.llm.model,actualModelRequests:true,chatAndMemoryWrites:false,cases:result},null,2));
console.log('Saved: '+out);
if(result.some(r=>r.exactQuoteIncluded===false||r.knownLoopAvoided===false))process.exitCode=1;
