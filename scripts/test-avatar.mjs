import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tsLoader } from './test-utils.mjs';
const file = p => fileURLToPath(new URL(p,import.meta.url));
const load=tsLoader({}, { performance:{now:()=>0} });
const protocol=load(file('../../mind/server/lib/avatarProtocol.ts'));
const good=()=>({id:'test-action',issuedAt:Date.now(),emotion:'soft',intensity:.8,durationMs:4000,motion:'nod',gaze:'center'});
assert.equal(protocol.validAvatarAction(good()),true);
for(const patch of [{emotion:'叉腰'},{motion:'eval'},{gaze:'desktop'},{intensity:NaN},{intensity:2},{durationMs:60000},{issuedAt:0},{id:'<script>'}])
  assert.equal(protocol.validAvatarAction({...good(),...patch}),false,JSON.stringify(patch));
assert.equal(protocol.avatarState({at:Date.now()-30000,available:true}),null);
assert.equal(protocol.avatarReplyContext({state:{at:Date.now(),available:true},seen:false,observation:'FAKE_IMAGE'}).includes('FAKE_IMAGE'),false);
const {TiqunAnimator}=load(file('../src/render/tiqun.ts'));
const a=new TiqunAnimator(0), b=new TiqunAnimator(0);
assert.ok(a.control(good(),0));
let nod,base;
for(let t=0;t<=640;t+=16){nod=a.frame(t,false);base=b.frame(t,false);}
assert.ok(nod.ParamAngleY < base.ParamAngleY-3,'点头真实进入每帧参数');
assert.equal(a.state(4500).emotion,'cheerful','动作结束恢复笑容');
assert.equal(a.state(4500).gaze,'cursor','恢复鼠标跟随');

let fetchMode='ok',executed=0,posted,receipt=null,pending=[],controlNow=Date.now(),applied=[];
const {createAvatarControl}=tsLoader({'../mind/client':{mindCfg:()=>({url:'http://test',token:'test'})}}, {
  document:{visibilityState:'visible'},window:{},requestAnimationFrame:fn=>setTimeout(fn,0),
  Date:class extends Date { static now(){return controlNow;} },
  fetch:async(_url,opts)=>{
    posted=JSON.parse(opts.body);
    if(fetchMode==='error')throw Error('vision unavailable');
    if(fetchMode==='pending')return new Promise(resolve=>pending.push(resolve));
    return {ok:true,json:async()=>({action:good(),seen:true,observation:'白色裙装的半身立绘'})};
  },
})(file('../src/render/avatar.ts'));
const {EventBus}=load(file('../src/core/bus.ts')),bus=new EventBus();
bus.on('avatar:receipt',v=>receipt=v);
const control=await createAvatarControl(bus,null);
bus.emit('avatar:renderer',{renderer:{avatarState:()=>({at:controlNow,available:true,view:'upper',emotion:'cheerful'}),
  captureAvatar:()=> 'data:image/jpeg;base64,YQ==',avatarAct:action=>{executed++;applied.push(action);return true;}}});
const observed=await control.context();
assert.equal(observed.status,'observed');assert.equal(observed.image,'data:image/jpeg;base64,YQ==');
assert.equal(executed,0,'读取当前立绘给聊天时不提前选择动作');
const out=await control.prepare('你可以点点头吗');
assert.equal(out.status,'executed');assert.equal(out.seen,true);assert.equal(out.state.view,'upper');assert.equal(executed,1);
await control.prepare('重复命令');assert.equal(receipt.status,'rejected');assert.equal(executed,1,'同一id不能执行两次');
fetchMode='error';assert.equal((await control.prepare('看不到时')).seen,false);
fetchMode='pending';const old=control.prepare('旧请求');
while(pending.length<1)await new Promise(r=>setTimeout(r,0));
const newer=control.prepare('新请求');
while(pending.length<2)await new Promise(r=>setTimeout(r,0));
pending[1]({ok:true,json:async()=>({action:{...good(),id:'new'},seen:true,observation:'新画面'})});
assert.equal((await newer).status,'executed');
pending[0]({ok:true,json:async()=>({action:{...good(),id:'old'},seen:true,observation:'旧画面'})});
assert.equal(await old,null,'旧观察结果不能覆盖较新动作');assert.equal(executed,2);
controlNow+=30000;
assert.equal((await control.reaffirm()).status,'executed','回复生成30秒后仍刷新动作');
assert.equal(applied.at(-1).issuedAt,controlNow,'不复用已过期的动作时间');
assert.equal(await control.reaffirm(),null,'同一回复只刷新一次');
assert.equal(executed,3);
const smiling=new TiqunAnimator(0);
smiling.control({...good(),emotion:'happy',durationMs:8000},0);
let speakingSmile;
for(let t=0;t<1500;t+=16) speakingSmile=smiling.frame(t,true);
assert.ok(speakingSmile.ParamAIHappy>.7,'说话时保留补画笑嘴');

let modelRequest;
const {planAvatar}=tsLoader({
  './persona.ts':{personaBase:()=> 'original persona'},
  './llm.ts':{chatStream:async(_cfg,messages)=>{modelRequest=messages;return {text:JSON.stringify({...good(),observation:'白裙角色'})};}},
})(file('../../mind/server/lib/avatar.ts'));
const state={at:Date.now(),available:true,view:'upper'};
const plan=await planAvatar({}, {text:'再试试别的',reply:'那来个委屈的。',state,image:'data:image/jpeg;base64,YQ==',previous:{status:'executed',state}});
assert.equal(plan.seen,true);assert.equal(modelRequest[1].images.length,1);
assert.ok(modelRequest[0].content.includes('上次执行回执'));
assert.equal(JSON.parse(modelRequest[1].content).finalReply,'那来个委屈的。','最终回复必须进入动作规划');
assert.equal(protocol.avatarMessages({state,status:'observed',image:'data:image/jpeg;base64,YQ=='})[1].images[0],'data:image/jpeg;base64,YQ==');
assert.equal(protocol.avatarMessages({state:{...state,at:0},image:'data:image/jpeg;base64,YQ=='}).length,0,'过期图像状态不作为当前自我观察');
const noImage=await planAvatar({}, {text:'hello',state,image:'invalid'});
assert.equal(noImage.seen,false);assert.equal(noImage.observation,'');
assert.equal(await planAvatar({}, {state:{...state,available:false}}).then(x=>x.available),false);
const canvases=[];
class TestImageData { constructor(data,width,height){this.data=data;this.width=width;this.height=height;} }
const {Live2DRenderer}=tsLoader({'../core/env':{assetUrl:p=>p}}, {
  document:{createElement:tag=>{
    const el={style:{},dataset:{},appendChild(){},clientHeight:20,
      getContext:()=>({putImageData(image){el.image=image;},fillRect(){},drawImage(raw){el.raw=raw;}}),
      toDataURL:()=> 'data:image/jpeg;base64,YQ=='};
    if(tag==='canvas')canvases.push(el);return el;
  }},ImageData:TestImageData,
})(file('../src/render/live2d.ts'));
const render=new Live2DRenderer('test');
render.animator={};render.captureBottomInset=5;
render.app={stage:{},renderer:{render(){},gl:{drawingBufferWidth:12,drawingBufferHeight:20,NO_ERROR:0,
  getError:()=>0,readPixels(_a,_b,w,h,_c,_d,pixels){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)pixels.set([y<5?255:0,0,y>=5?255:0,255],(y*w+x)*4);
  }}}};
assert.ok(render.captureAvatar());
const captured=canvases.at(-1).raw.image;
assert.equal(captured.height,15,'半身截图使用实际裁切边界，不依赖浏览器重写CSS简写');
assert.equal(captured.data.filter((_,i)=>i%4===0).some(v=>v>0),false,'隐藏的下半身像素未进入自画像');
render.captureBottomInset=0;assert.ok(render.captureAvatar());
assert.equal(canvases.at(-1).raw.image.height,20,'全身完整保留');
console.log('PASS avatar: 范围校验、每帧动作、超时恢复、回执、重复/过期/乱序拒绝、看图失败如实反馈、实际帧缓冲裁切与上下翻转');
