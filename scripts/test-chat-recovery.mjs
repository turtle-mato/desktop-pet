import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {tsLoader} from './test-utils.mjs';
import {chatStream} from '../../mind/server/lib/llm.ts';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
let body;
const originalFetch=globalThis.fetch;
const config={llm:{mode:'deepseek',baseUrl:'http://isolated.test/v1',apiKey:'test-only',model:'test',thinking:'max'}};
const wire = chunks => new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}}));
try{
  const line='data: '+JSON.stringify({choices:[{delta:{content:'正常中文回复'},finish_reason:'stop'}]});
  const bytes=new TextEncoder().encode(line);
  globalThis.fetch=async(_url,init)=>{body=JSON.parse(init.body);return wire([bytes.slice(0,58),bytes.slice(58,59),bytes.slice(59)]);};
  const image='data:image/png;base64,AAAA';
  const out=await chatStream(config,[{role:'system',content:'角色设定'},{role:'assistant',content:'旧话'},{role:'system',content:'最新核对规则'},{role:'user',content:'看图',images:[image]}],()=>{});
  assert.equal(out.text,'正常中文回复','flush final SSE line and split UTF-8');
  assert.equal(body.messages.filter(m=>m.role==='system').length,1);
  assert.equal(body.messages[0].content,'角色设定\n\n最新核对规则');
  assert.equal(body.messages[1].content,'旧话');
  assert.equal(body.messages.at(-1).content[1].image_url.url,image);
  assert.equal(body.thinking.type,'enabled','preserve thinking config');
  for(const event of [{error:{message:'upstream unavailable'}},{choices:[{delta:{reasoning_content:'private reasoning'},finish_reason:'stop'}]}]){
    globalThis.fetch=async()=>wire([new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n')]);
    await assert.rejects(chatStream(config,[{role:'user',content:'hello'}],()=>assert.fail('never emit reasoning')),/模型流返回错误|模型未返回正文/);
  }
  let requests=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);requests++;
    if(requests===2){assert.equal(body.thinking.type,'disabled');assert.equal(body.max_tokens,1024);}
    const event=requests===1?{choices:[{delta:{reasoning_content:'private'},finish_reason:'stop'}]}:{choices:[{delta:{content:'哥，题刷到哪儿了？'},finish_reason:'stop'}]};
    return wire([new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n')]);
  };
  const recovered=await chatStream(config,[{role:'user',content:'刷洛谷ing'}],()=>{},{recoverEmpty:true});
  assert.equal(recovered.text,'哥，题刷到哪儿了？');assert.equal(requests,2);assert.equal(recovered.usage.emptyRecovery,true);
  requests=0;
  globalThis.fetch=async()=>{requests++;return wire([new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'private'},finish_reason:'stop'}]})+'\n\n')]);};
  await assert.rejects(chatStream(config,[{role:'user',content:'hi'}],()=>{},{recoverEmpty:true}),/模型未返回正文/);
  assert.equal(requests,2,'empty recovery never loops');
  requests=0;
  globalThis.fetch=async()=>{requests++;return wire([new TextEncoder().encode('data: '+JSON.stringify({error:{message:'test error'}})+'\n\n')]);};
  await assert.rejects(chatStream(config,[{role:'user',content:'hi'}],()=>{},{recoverEmpty:true}),/test error/);
  assert.equal(requests,1,'explicit upstream failures are not retried');
}finally{globalThis.fetch=originalFetch;}
const {createRecentChatRestorer}=tsLoader()(file('../src/chat/restore.ts'));
let healthy=false,healthCalls=0;
const client=tsLoader({'../core/config':{getSection:(_n,d)=>d,setSection:()=>{}},'../core/env':{env:{serverBase:''}}},{fetch:async()=>{healthCalls++;return {ok:true,json:async()=>({ok:healthy})};}})(file('../src/mind/client.ts'));
assert.equal(await client.mindUsable(),false);
healthy=true;await client.mindHealth();
assert.equal(await client.mindUsable(),true,'a healthy probe invalidates the startup failure cache immediately');
assert.equal(healthCalls,2);
let ready=false,thinking=false,calls=0,fail=false,applied=[];
const restore=createRecentChatRestorer({usable:async()=>ready,thinking:()=>thinking,recent:async()=>{calls++;if(fail)throw Error('temporary');return {items:[{role:'pet',text:'旧回复',ts:1},{role:'user',text:'今天的原话',ts:2},{role:'sys',text:'skip',ts:3}]};},apply:turns=>{applied=turns;return turns.length;}});
assert.equal(await restore(),false);assert.equal(calls,0,'offline startup must stay retryable');
ready=true;fail=true;assert.equal(await restore(),false);
fail=false;thinking=true;assert.equal(await restore(),false,'do not reset a live stream');
thinking=false;await Promise.all([restore(),restore()]);assert.equal(calls,2,'concurrent reconnects share a request');
assert.equal(applied.length,2);assert.equal(applied[0].role,'assistant');
await restore();assert.equal(calls,2,'successful restore not repeated on each health tick');
const events=[];
const {ChatEngine}=tsLoader({
 '../core/config':{getSection:(_n,d)=>d},'../core/session':{greetingByHour:()=>''},
 '../mind/client':{mindUsable:async()=>true,mindSend:async()=>{throw Error('模型未返回正文');},markMindFailed:()=>assert.fail('generation failure does not disconnect mind')},
 './persona':{buildPersonaPrompt:()=>'',fillTokens:s=>s},
 './fallback':{localReply:()=>assert.fail('never replace a failed online reply with a canned memory'),topicLine:()=>''},
})(file('../src/chat/engine.ts'));
const engine=new ChatEngine({bus:{emit:(name,p)=>events.push({name,...p})},session:{activity:{label:''},minutesOn:()=>0},personas:{active:()=>({name:'她'})},apiRef:{}});
engine.history=[{role:'user',text:'刚发的新话',ts:9},{role:'assistant',text:'旧回复',ts:2}];
assert.equal(engine.restoreRecent([{role:'user',text:'今天的原话',ts:1},{role:'assistant',text:'旧回复',ts:2}]),3);
assert.deepEqual(Array.from(engine.history,t=>t.ts),[1,2,9],'old and new history remain chronological without duplicates');
assert.equal(events.filter(e=>e.name==='chat:reset').length,1);
assert.ok(events.filter(e=>e.name==='chat:user'||e.name==='chat:pet').every(e=>e.restore===true),'hydration never broadcasts as a new bubble');
events.length=0;await engine.ask('刷洛谷ing');
assert.ok(events.some(e=>e.kind==='sys'&&e.text.includes('这条回复没成功')));
assert.ok(!events.some(e=>e.text?.includes('大脑没连上')));
console.log('chat recovery passed: system ordering, SSE errors/EOF/UTF8, ready retry/dedup, chronological hydration, honest reply failure');
