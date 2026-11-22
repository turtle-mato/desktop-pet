import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {tsLoader,flush} from './test-utils.mjs';
import {randomUUID} from 'node:crypto';
const handlers=new Map(),timers=new Map();let next=0;
const events={listen:async(name,fn)=>{const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);return()=>handlers.set(name,list.filter(f=>f!==fn));},
 emit:async(name,payload)=>{for(const fn of handlers.get(name)||[])fn({payload});}};
const load=tsLoader({}, {crypto:{randomUUID},setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
const {installScreenControl}=load(fileURLToPath(new URL('../src/core/screenControl.ts',import.meta.url)));
let state={enabled:true,status:'watching'},nativeCalls=[],dormantCalls=0,persisted=true;
const main={'screen-awareness':{snapshot:()=>state,setEnabled:async enabled=>{nativeCalls.push(enabled);persisted=enabled;state={enabled,status:enabled?'waiting':'off'};await events.emit('pet:screen',state);}}};
const mini={'screen-awareness':{snapshot:()=>state,setEnabled:()=>dormantCalls++}};
await events.listen('pet:screen',({payload})=>{mini['screen-awareness']={...mini['screen-awareness'],snapshot:()=>payload};});
const offMain=await installScreenControl(main,{},false,events);
const offMini=await installScreenControl(mini,{},true,events);
await mini['screen-awareness'].setEnabled(false);await flush();
assert.equal(mini['screen-awareness'].snapshot().enabled,false);assert.equal(persisted,false);assert.equal(dormantCalls,0);
await mini['screen-awareness'].setEnabled(true);assert.deepEqual(nativeCalls,[false,true]);assert.equal(mini['screen-awareness'].snapshot().enabled,true);
offMain();const stalled=mini['screen-awareness'].setEnabled(false);await flush();
for(const [id,fn] of timers){timers.delete(id);fn();}await assert.rejects(stalled,/未确认/);offMini();
assert.equal(dormantCalls,0);assert.equal(timers.size,0);
console.log('screen control: mini controls only main, both snapshots follow real state, persistence, timeout passed');

// The actual button updates all copies, ignores double clicks, and reads the
// new API object (mini replaces snapshots when a broadcast arrives).
class Element {constructor(){this.attrs={};this.dataset={};this.children=[];} setAttribute(k,v){this.attrs[k]=v;} appendChild(v){this.children.push(v);}addEventListener(k,f){this[k]=f;} }
const listeners=[],api={};let changed,callCount=0;
api['screen-awareness']={snapshot:()=>({enabled:true}),setEnabled:async enabled=>{callCount++;await new Promise(r=>changed=r);api['screen-awareness']={...api['screen-awareness'],snapshot:()=>({enabled})};for(const fn of listeners)fn({enabled});}};
const {createScreenToggle}=tsLoader({'./dom':{button:(text,cls,fn)=>{const el=new Element();el.textContent=text;el.className=cls;el.click=()=>el.disabled?undefined:fn();return el;}}})(fileURLToPath(new URL('../src/ui/screenToggle.ts',import.meta.url)));
const bus={on:(_n,f)=>listeners.push(f)},a=createScreenToggle(bus,api),b=createScreenToggle(bus,api);
const click=a.click();a.click();assert.equal(callCount,1);assert.equal(a.disabled,true);changed();await click;
assert.equal(a.textContent,'读屏：关');assert.equal(b.textContent,'读屏：关');assert.equal(a.attrs['aria-checked'],'false');assert.equal(a.disabled,false);
api['screen-awareness'].setEnabled=async()=>{throw Error('测试断开');};await a.click();assert.match(a.title,/测试断开/);assert.equal(a.disabled,false);assert.equal(a.textContent,'读屏：关');
console.log('screen toggle: main/mini shared state, pending double-click protection, stale-object isolation, failure recovery passed');
