import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {tsLoader} from './test-utils.mjs';
let usable=true,key='',mode='ok',request,localRequest,mindCalls=0,localCalls=0,finalReply='看到了红方块';
const events=[];
const {ChatEngine}=tsLoader({
 '../core/config':{getSection:(_n,d)=>({...d,apiKey:key})},
 '../mind/client':{mindCfg:()=>({sessionId:'test'}),mindUsable:async()=>usable,markMindFailed:()=>assert.fail('image failure must not disconnect healthy mind'),
  mindSend:async(text,_delta,opts)=>{mindCalls++;request={text,opts};events.push({event:'mind:request'});if(mode==='error')throw Error('unsupported image');_delta(finalReply);return {text:mode==='empty'?'':finalReply};},
  describeImage:()=>assert.fail('must not replace actual image with a textual description')},
 './providers':{chatStream:async(_cfg,msgs)=>{localCalls++;localRequest=msgs;if(mode==='error')throw Error('image rejected');return mode==='empty'?'':'local saw image';}},
 './persona':{buildPersonaPrompt:()=>'',fillTokens:s=>s},
 './fallback':{localReply:()=>assert.fail('never fake an image response'),topicLine:()=>''},
 '../core/session':{greetingByHour:()=>''},
})(fileURLToPath(new URL('../src/chat/engine.ts',import.meta.url)));
const fresh=(avatar)=>new ChatEngine({bus:{emit:(event,p)=>events.push({event,...p})},session:{activity:{label:'测试'},minutesOn:()=>0},personas:{active:()=>({name:'她',systemPrompt:''})},apiRef:{avatar}});
const image='data:image/png;base64,iVBORw0KGgoBAgME';
await fresh().ask('图片里是什么？',image);
assert.equal(request.opts.image,image);assert.equal(request.text,'图片里是什么？');assert.equal(localCalls,0);
await fresh().ask('',image);assert.equal(request.text,'[图片]');
await fresh().ask('/help',image);assert.equal(request.text,'/help','caption with command syntax must still reach image model');
for(const m of ['error','empty']){mode=m;events.length=0;await fresh().ask('看图',image);assert.equal(localCalls,0);assert.ok(events.some(e=>e.kind==='sys'&&e.text.includes('图片回复失败')));}
usable=false;mode='ok';events.length=0;await fresh().ask('看图',image);
assert.ok(events.some(e=>e.kind==='sys'&&e.text.includes('无法把图片交给模型')));
key='local-test';await fresh().ask('看图',image);assert.equal(localRequest.at(-1).images.length,1);assert.equal(localRequest.at(-1).images[0],image);
for(const m of ['error','empty']){mode=m;events.length=0;await fresh().ask('看图',image);assert.ok(events.some(e=>e.kind==='sys'&&e.text.includes('图片回复失败')));}
assert.ok(mindCalls>=5);
usable=true;mode='ok';
for(const [text,reply] of [['能看到咯，再做个别的表情','那换个惊讶的，你看这次准不准。'],
 ['再试试别的','那来个委屈的。看我这张脸有没有那味。']]){
 events.length=0;finalReply=reply;let actionInput;
 await fresh({context:async()=>({state:{available:true},status:'observed',image:'data:image/jpeg;base64,YQ=='}),
  prepare:async(userText,_allowed,chosenReply)=>{actionInput={userText,chosenReply};
   assert.ok(events.some(e=>e.event==='mind:request'),'先得到完整回复再决定动作');
   assert.ok(!events.some(e=>e.event==='chat:delta'||e.event==='chat:pet'),'动作未执行时不能先展示表情宣告');
   events.push({event:'avatar:executed'});return {status:'executed'};},
  reaffirm:()=>assert.fail('不能重播用户消息阶段选错的动作')}).ask(text);
 assert.equal(request.opts.avatar.status,'observed');
 assert.deepEqual(actionInput,{userText:text,chosenReply:reply},'动作必须根据本次最终回复，而不是单独猜“别的”');
 assert.ok(events.findIndex(e=>e.event==='avatar:executed')<events.findIndex(e=>e.event==='chat:pet'));
}
console.log('image engine: original bytes+caption, image-only, no preprocessing, no fabricated error/empty/offline fallback, local multimodal passed');
