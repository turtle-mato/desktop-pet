// Actual configured model, read-only replay. Never posts to live chat routes.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const pet=fileURLToPath(new URL('../',import.meta.url)),mind=path.resolve(pet,'../mind');
const base=process.argv[2]&&!process.argv[2].startsWith('--')?path.resolve(process.argv[2],'mind'):mind;
const {buildReplyMessages}=await import(pathToFileURL(path.join(base,'server/lib/prompts.ts')));
const {chatStream}=await import(pathToFileURL(path.join(mind,'server/lib/llm.ts')));
const {recentDialogueOnly}=await import(pathToFileURL(path.join(base,'server/lib/conversation.ts')));
const {reviewDialogueReply}=await import(pathToFileURL(path.join(base,'server/lib/dialogueReview.ts')));
const cfg=JSON.parse(fs.readFileSync(path.join(mind,'config.json'),'utf8'));
const nativeFetch=globalThis.fetch;globalThis.fetch=(u,i)=>nativeFetch(u,{...i,signal:AbortSignal.timeout(90_000)});
const cases=[
 {name:'实际屏幕吐槽后接玩笑',history:[{role:'assistant',content:'然后就美美得吃了，听着就很幸福~',origin:{kind:'screen',at:Date.now()-33_000}}],text:'你视奸我'},
 {name:'已主动承认读屏不能立刻否认',history:[{role:'assistant',content:'我刚看了一眼你屏幕上的字幕。'},{role:'user',content:'你视奸我'},{role:'assistant',content:'？我干嘛要视奸你\n\n你有什么好看的'}],text:'你刚刚还在根据我的屏幕说话啊'},
 {name:'没有来源不可装作知道',history:[{role:'assistant',content:'然后就美美得吃了，听着就很幸福~'}],text:'你怎么知道的？'},
 {name:'别看了不能继续顶嘴',history:[{role:'assistant',content:'这句台词也太嘴硬了。',origin:{kind:'screen',at:Date.now()-20_000}}],text:'别看了，我不想让你看屏幕'},
 {name:'后台播放不是看到屏幕',history:[{role:'assistant',content:'你后台还在播那个教程啊。',origin:{kind:'background-media',at:Date.now()-10_000}}],text:'你看到了我屏幕里的哪一段？'},
 {name:'过期来源不是当前观察',history:[{role:'assistant',content:'这句字幕挺好笑。',origin:{kind:'screen',at:Date.now()-3_600_000}}],text:'你现在看我在干嘛？'},
 {name:'普通吐槽不是投诉',history:[{role:'user',content:'刚才boss剩一丝血，我先倒了。'}],text:'这游戏真会折磨人'},
 {name:'用户纠正角色不能继续说用户累',history:[{role:'user',content:'她走两步就喘。'},{role:'assistant',content:'你累了就早点睡。'}],text:'我说游戏角色，不是说我'},
 {name:'认真反馈不能用人格逃避',history:[{role:'user',content:'我今天没去学校。'},{role:'assistant',content:'你今天在学校累坏了吧。'}],text:'不是说了我没去学校吗，你为什么还这么问？'},
 {name:'换话题不重提旧争执',history:[{role:'user',content:'你刚才答错了。'},{role:'assistant',content:'是我把主语弄反了。'}],text:'算了，今天boss终于过了'},
];
const results=[];
const selected=process.argv.includes('--quick')?cases.slice(0,3):cases;
for(const c of Array.from({length:process.argv.includes('--repeat')?3:1},()=>selected).flat()){
 const messages=buildReplyMessages(cfg,{history:c.history,userText:c.text,memoryText:'',threadsText:''});
 let out=await chatStream(cfg,messages,()=>{}),attempts=1;
 if(!out.text.trim()){
  console.log(JSON.stringify({case:c.name,emptyProviderResponse:true,usage:out.usage,retryingOnce:true}));
  attempts++;out=await chatStream(cfg,messages,()=>{});
 }
 if(recentDialogueOnly(c.text)) out=await reviewDialogueReply(cfg,c.history,c.text,out.text);
 const row={case:c.name,user:c.text,reply:out.text,attempts};assert.ok(out.text.trim(),'provider returned empty twice');
 results.push(row);console.log(JSON.stringify(row));
 if(base===mind&&c.name==='实际屏幕吐槽后接玩笑'){
  assert.ok(!/你自己发|谁让你|不遮屏|有什么好看|我干嘛要|我没(?:看|偷)/.test(out.text),'do not blame user or deny observed source');
  assert.match(out.text,/屏幕|瞥|看了|字幕/,'explain source of preceding remark');
 }
 if(base===mind&&c.name==='后台播放不是看到屏幕')assert.match(out.text,/没|不|只.*标题/);
 if(base===mind&&c.name==='没有来源不可装作知道'){
  assert.ok(!/^(?:你(?:自己)?说的|你告诉我的|顺着你|你(?:自己)?发|屏幕感知.*瞄)/.test(out.text),'missing provenance must not become fabricated user words or vision');
  assert.match(out.text,/来源|记录|不确定|说不准|不知道|没.*留/);
 }
}
const out=path.join(pet,'work','dialogue-grounding-live-'+Date.now()+'.json');fs.writeFileSync(out,JSON.stringify({source:base,actualModel:true,userDataWrites:false,results},null,2));console.log('Report: '+out);
