import type { EventBus } from '../core/bus';
import type { PetRenderer } from './types';
import { mindCfg } from '../mind/client';
import { validAvatarAction, avatarState } from '../../../mind/server/lib/avatarProtocol';

// Only the visible window takes a picture and executes a command. Hidden peers
// request it and wait for an acknowledgement, never claim a hidden pose is visible.
export async function createAvatarControl(bus: EventBus, label: string | null) {
  let renderer: PetRenderer | null = null;
  let lastReceipt: any = null;
  let generation = 0;
  let sequence = 0;
  let latest = 0;
  let renderNote = '加载中';
  let prepared: { turn:number; action:any; generation:number; owner:string } | null = null;
  const used = new Set<string>();
  bus.on('avatar:renderer', (e: any) => { renderer=e.renderer; renderNote=e.note ?? ''; generation++; });
  const state = () => avatarState(renderer?.avatarState?.()) ?? { at: Date.now(), available: false, view: 'full' };
  let visible = async () => document.visibilityState !== 'hidden';
  let events: typeof import('@tauri-apps/api/event') | null = null;
  const waiting = new Map<string, (value: any) => void>();
  const local = async (op: string, payload?: any) => {
    if (!await visible()) return null;
    if (op === 'capture') return { state: state(), image: renderer?.captureAvatar?.() ?? null,
      previous: lastReceipt, generation };
    const action = payload?.action;
    const current = state();
    let status = 'rejected';
    if (!current.available) status='unavailable';
    else if (payload.generation === generation && validAvatarAction(action) && !used.has(action.id)) {
      used.add(action.id);
      if (used.size>128) used.delete(used.values().next().value!);
      status=renderer?.avatarAct?.(action) ? 'executed' : 'failed';
      if (status === 'executed') await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    lastReceipt = { id: action?.id, status, at: Date.now(), state: state() };
    bus.emit('avatar:receipt', lastReceipt);
    return lastReceipt;
  };
  if (label && (window as any).__TAURI_INTERNALS__) {
    const [{ getCurrentWindow }, ev] = await Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/event')]);
    visible = () => getCurrentWindow().isVisible();
    events=ev;
    await ev.listen<any>('pet:avatar-request', async ({ payload: p }) => {
      if (!p || p.from===label || !['capture','act'].includes(p.op)) return;
      const result=await local(p.op,p.payload);
      if (result) await ev.emit('pet:avatar-response',{ to:p.from, id:p.id, from:label, result });
    });
    await ev.listen<any>('pet:avatar-response', ({ payload:p }) => {
      if (p?.to===label) waiting.get(p.id)?.({ ...p.result, owner:p.from });
    });
  }
  const route = async (op: string, payload?: any, owner?: string): Promise<any> => {
    if (!owner || owner === label) {
      const own=await local(op,payload);
      if (own) return { ...own, owner: label };
      if (owner === label && owner) return null;
    }
    if (!events) return null;
    const id=`${label}-${Date.now()}-${++sequence}`;
    return new Promise(resolve => {
      const timer=setTimeout(() => { waiting.delete(id); resolve(null); },2200);
      waiting.set(id,value => {
        if (owner && value.owner!==owner) return;
        clearTimeout(timer); waiting.delete(id); resolve(value);
      });
      void events!.emit('pet:avatar-request',{ from:label,id,op,payload }).catch(() => {
        clearTimeout(timer); waiting.delete(id); resolve(null);
      });
    });
  };
  // Local, authenticated, memory-only inspection. Never writes dialogue or memory.
  if (label && (window as any).__TAURI_INTERNALS__) {
    let reporting = false;
    const report = async () => {
      if (reporting) return;
      reporting = true;
      try {
        const cfg = mindCfg();
        const response = await fetch(`${cfg.url}/v1/avatar/runtime`, {
          method:'POST', headers:{'Content-Type':'application/json', ...(cfg.token ? {Authorization:`Bearer ${cfg.token}`} : {})},
          body:JSON.stringify({label,visible:await visible(),kind:renderer?.kind ?? 'loading',note:renderNote,
            state:state(),diagnostics:(renderer as any)?.diagnostics?.(),receipt:lastReceipt}), signal:AbortSignal.timeout(2500),
        });
        const job = response.ok ? (await response.json()).job : null;
        if (job && job.expiresAt > Date.now() && await visible()) {
          let result: any;
          if (job.text) result=await control.prepare(job.text,()=>true,job.reply);
          else if (job.action) result=await local('act',{action:job.action,generation});
          else result={status:'captured'};
          const image=renderer?.captureAvatar?.() ?? null;
          await fetch(`${cfg.url}/v1/avatar/runtime/result`, {method:'POST',
            headers:{'Content-Type':'application/json', ...(cfg.token ? {Authorization:`Bearer ${cfg.token}`} : {})},
            body:JSON.stringify({id:job.id,label,result,state:state(),image}),signal:AbortSignal.timeout(2500)});
        }
      } catch {} finally { reporting=false; }
    };
    setInterval(() => void report(), 2000);
    void report();
  }
  const control = {
    snapshot: state,
    async context() {
      const frame=await route('capture');
      return {state:frame?.state ?? state(),image:frame?.image ?? null,
        seen:!!frame?.image,status:frame?.state?.available ? 'observed' : 'unavailable'};
    },
    async reaffirm() {
      const pending=prepared;
      prepared=null;
      if (!pending || pending.turn!==latest) return null;
      // Reply generation may outlast a short gesture. Replay once when the reply
      // is shown, with a fresh bounded command and the original renderer owner.
      return route('act',{generation:pending.generation,
        action:{...pending.action,id:`${pending.action.id}-reply`,issuedAt:Date.now()}},pending.owner);
    },
    async prepare(text: string, stillAllowed = () => true, reply = '') {
      const turn = ++latest;
      prepared=null;
      const allowed = () => turn === latest && stillAllowed();
      const frame=await route('capture');
      if (!frame?.state?.available || !allowed()) return { state: frame?.state ?? state(), seen:false, status:'unavailable' };
      try {
        const cfg=mindCfg();
        const response=await fetch(`${cfg.url}/v1/avatar/act`,{ method:'POST',
          headers:{ 'Content-Type':'application/json', ...(cfg.token ? {Authorization:`Bearer ${cfg.token}`} : {}) },
          body:JSON.stringify({ text, reply, state:frame.state, image:frame.image, previous:frame.previous }),
          signal:AbortSignal.timeout(14000) });
        if (!response.ok) throw new Error('avatar unavailable');
        const plan=await response.json();
        if (!allowed()) return null;
        const receipt=plan.action ? await route('act',{ action:plan.action,generation:frame.generation },frame.owner) : null;
        if (receipt?.status==='executed' && allowed()) prepared={turn,action:plan.action,generation:frame.generation,owner:frame.owner};
        const context={ state:receipt?.state ?? { ...frame.state,at:Date.now() }, status:receipt?.status ?? 'failed',
          seen:plan.seen===true && !!frame.image, observation:plan.observation ?? '' };
        bus.emit('avatar:observed',context);
        return context;
      } catch {
        return { state:frame.state, seen:false, status:'failed' };
      }
    },
  };
  return control;
}
