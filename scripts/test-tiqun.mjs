import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsLoader } from './test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = tsLoader({}, { performance: { now: () => 0 } });
const { TiqunAnimator } = load(path.join(root, 'src/render/tiqun.ts'));
const { tiqunFrame, TIQUN_MODEL } = load(path.join(root, 'src/render/framing.ts'));
for (const [w,h] of [[430,330],[200,200/.65],[200,200/.806],[700,500]]) {
  const full = tiqunFrame('full',w,h,2217,3259);
  assert.ok(full.y >= 0 && full.y + 3259*full.scale <= h);
  const upper = tiqunFrame('upper',w,h,2217,3259);
  assert.ok(upper.scale > full.scale*1.4, '上半身确实放大');
  assert.ok(upper.y >= 0 && upper.y + 3000*upper.scale > h, '保留头顶并裁去小腿');
  assert.ok(upper.bottom < upper.y + 1750*upper.scale,'半身遮罩收在腰部、不露腿');
}

const disk = new Map([['desktop-pet.v1.appearance.store',JSON.stringify({accentColor:'#123456',renderer:'image',live2dModel:'/old.json'})],['desktop-pet.v1.personas.store','do-not-touch'],['memory','do-not-touch']]);
const localStorage = { getItem:k=>disk.get(k)??null, setItem:(k,v)=>disk.set(k,v) };
const appLoad = tsLoader({'./character':{baseCharacter:()=>({accentColor:'#abcdef'})}}, {localStorage});
const { EventBus } = appLoad(path.join(root,'src/core/bus.ts'));
const { AppearanceStore } = appLoad(path.join(root,'src/core/persona.ts'));
const bus = new EventBus(), store = new AppearanceStore(bus);
assert.equal(store.get().renderer,'live2d'); assert.equal(store.get().live2dModel,TIQUN_MODEL);
assert.equal(store.get().accentColor,'#123456');
store.set({view:'upper'});
assert.equal(new AppearanceStore(bus).get().view,'upper');
store.set({renderer:'image'});
assert.equal(new AppearanceStore(bus).get().renderer,'image','只迁移一次');
assert.equal(disk.get('desktop-pet.v1.personas.store'),'do-not-touch'); assert.equal(disk.get('memory'),'do-not-touch');

class Element {
  nodeType=1; children=[]; events={}; dataset={}; attrs={}; hidden=false;
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(n,fn){(this.events[n]??=[]).push(fn);}
  appendChild(c){this.children.push(c);}
  fire(n,e={stopPropagation(){}}){for(const fn of this.events[n]||[])fn(e);}
}
const uiLoad=tsLoader({}, {document:{createElement:()=>new Element(),createTextNode:text=>({nodeType:3,text})},Node:Element});
const {createViewSwitch}=uiLoad(path.join(root,'src/ui/viewSwitch.ts'));
const views=[];const control=createViewSwitch(store,bus);
control.attach({setView:view=>views.push(view)});
control.element.children[0].fire('click'); assert.equal(store.get().view,'full');
control.element.children[1].fire('click'); assert.equal(store.get().view,'upper');
assert.equal(control.element.children[1].attrs['aria-pressed'],'true');
assert.equal(views.at(-1),'upper');
let stopped=false; control.element.fire('mousedown',{stopPropagation(){stopped=true;}});assert.ok(stopped);

const base=path.join(root,'public/live2d/tiqun-v2');
const refs=JSON.parse(fs.readFileSync(path.join(base,'rig-input.model3.json'))).FileReferences;
for(const f of [refs.Moc,...refs.Textures,refs.DisplayInfo,...refs.Expressions.map(e=>e.File),...Object.values(refs.Motions).flat().map(m=>m.File)]) assert.ok(fs.statSync(path.join(base,f)).size>0,f);
const coreSource=fs.readFileSync(path.join(root,'public/live2d/core/live2dcubismcore.min.js'),'utf8');
new Function('window','self','document',coreSource+';globalThis.Live2DCubismCore=Live2DCubismCore;')(globalThis,globalThis,{createElement:()=>({getContext:()=>null}),currentScript:null,addEventListener(){}});
const Core=globalThis.Live2DCubismCore;
for(let i=0;i<40;i++){try{Core.Version.csmGetVersion();break;}catch{await new Promise(r=>setTimeout(r,100));}}
const data=fs.readFileSync(path.join(base,refs.Moc));
const moc=Core.Moc.fromArrayBuffer(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
const model=Core.Model.fromMoc(moc);assert.ok(model);
const anim=new TiqunAnimator(0), ranges={};
const sample=(t,speaking)=>{
  const pose=anim.frame(t,speaking),p=model.parameters;p.values.set(p.defaultValues);
  for(const [id,v] of Object.entries(pose)){
    assert.ok(Number.isFinite(v),id); const i=p.ids.indexOf(id); assert.ok(i>=0,id);p.values[i]=v;
    ranges[id]??=[v,v];ranges[id][0]=Math.min(v,ranges[id][0]);ranges[id][1]=Math.max(v,ranges[id][1]);
  }
  model.update();for(const v of model.drawables.vertexPositions)assert.ok(v.every(Number.isFinite));
  return pose;
};
for(let i=0;i<720;i++)sample(i*1000/60,i>240&&i<320);
for(const id of ['ParamBreath','ParamBodyAngleX','ParamAIClosed','ParamAIHalf','ParamMouthOpenY']) assert.ok(ranges[id][1]-ranges[id][0]>.1,id+' actually animates');
anim.play('happy',12000);let happy;for(let t=12000;t<14000;t+=16)happy=sample(t,false);
assert.ok(happy.ParamMouthOpenY>.15 && happy.ParamMouthForm>.7 && happy.ParamAIHappy===0,'开心时保留正常张嘴');
assert.equal(sample(14016,true).ParamAIHappy,0,'说话时关闭补画嘴，避免双嘴');
anim.play('sad',15000);let sad;for(let t=15000;t<17000;t+=16)sad=sample(t,false);assert.ok(sad.ParamAISad>.95);
sample(19000,false);for(let t=19000;t<21000;t+=16)sad=sample(t,false);assert.ok(sad.ParamAISad<.01,'临时表情能恢复');
anim.setGaze(1,1);let right;for(let t=21000;t<22000;t+=16)right=sample(t,false);
anim.setGaze(-1,-1);let left;for(let t=22000;t<23000;t+=16)left=sample(t,false);
assert.ok(right.ParamEyeBallX>.6 && left.ParamEyeBallX<-.6,'视线左右跟随');
assert.ok(right.ParamEyeBallY>.4 && left.ParamEyeBallY<-.4,'视线上下跟随');
assert.ok(Math.abs(right.ParamAngleX)<8 && Math.abs(left.ParamAngleX)<8,'头转角保持安全幅度');
console.log('PASS: 实际 Core / 32 参数 / 连续几何、呼吸眨眼口型、表情恢复、全半身、按钮、防拖动、外观迁移与数据隔离');
model.release();moc._release();
