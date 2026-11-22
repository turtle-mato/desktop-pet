import { expressionPose, expressionFrame, idlePose, blinkAmount, applyBlink, blendPose } from './tiqun-emotions';
import type { PetAnim, PetTone } from './types';
import { validAvatarAction, type AvatarAction } from '../../../mind/server/lib/avatarProtocol';

export class TiqunAnimator {
  private expression = expressionPose('cheerful');
  private emotion = 'cheerful';
  private resting = 'cheerful';
  private targetGaze = { x: 0, y: 0 };
  private gaze = { x: 0, y: 0 };
  private until = 0;
  private blinkAt = -Infinity;
  private previous = 0;
  private epoch: number;
  private action: AvatarAction | null = null;
  private actionAt = 0;

  constructor(now = performance.now()) { this.epoch = now; }

  play(anim: PetAnim, now = performance.now()): void {
    if (anim === 'blink') { this.blinkAt = now; return; }
    this.emotion = ({ happy: 'cheerful', sad: 'sad', sleepy: 'sleepy', angry: 'sad', tossed: 'surprised' })[anim] || this.resting;
    this.until = anim === 'idle' ? 0 : now + 3600;
  }

  setTone(tone: PetTone): void {
    this.resting = tone === 'angry' ? 'sad' : tone === 'cool' ? 'neutral' : 'cheerful';
    if (!this.until) this.emotion = this.resting;
  }

  setGaze(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.targetGaze = { x: Math.max(-1,Math.min(1,x)), y: Math.max(-1,Math.min(1,y)) };
  }

  control(action: AvatarAction, now = performance.now()): boolean {
    if (!validAvatarAction(action)) return false;
    this.action = action;
    this.actionAt = now;
    if (action.motion === 'blink') this.blinkAt = now;
    return true;
  }

  state(now = performance.now()) {
    const a = this.action && now - this.actionAt < this.action.durationMs ? this.action : null;
    return { emotion: a?.emotion ?? (this.until && now < this.until ? this.emotion : this.resting),
      intensity: a?.intensity ?? 1, motion: a?.motion ?? 'none', gaze: a?.gaze ?? 'cursor' };
  }

  frame(now: number, speaking: boolean): Record<string, number> {
    const dt = this.previous ? (now - this.previous) / 1000 : 1 / 60;
    this.previous = now;
    if (this.until && now >= this.until) { this.until = 0; this.emotion = this.resting; }
    const state = this.state(now);
    this.expression = blendPose(this.expression, expressionPose(state.emotion, state.intensity), dt);
    const pose = expressionFrame(this.expression);
    const t = (now - this.epoch) / 1000;
    for (const [id, value] of Object.entries(idlePose(t, { emotion: this.emotion }))) pose[id] += value;
    const follow = 1 - Math.exp(-Math.max(0,Math.min(.1,dt))*9);
    const target = state.gaze === 'cursor' ? this.targetGaze : { x: state.gaze === 'left' ? -.65 : state.gaze === 'right' ? .65 : 0, y: state.gaze === 'down' ? -.5 : 0 };
    this.gaze.x += (target.x-this.gaze.x)*follow;
    this.gaze.y += (target.y-this.gaze.y)*follow;
    pose.ParamAngleX = pose.ParamAngleX*.3 + this.gaze.x*5;
    pose.ParamAngleY += this.gaze.y*2;
    pose.ParamEyeBallX = this.gaze.x*.65;
    pose.ParamEyeBallY += this.gaze.y*.5;
    const progress = Math.max(0, Math.min(1, (now-this.actionAt)/1300));
    const gesture = progress < 1 ? Math.sin(progress*Math.PI)**2 : 0;
    if (state.motion === 'nod') pose.ParamAngleY -= gesture*4;
    if (state.motion === 'tilt') pose.ParamAngleZ += gesture*4;
    const b = (now - this.blinkAt) / 420;
    applyBlink(pose, Math.max(blinkAmount(t, this.emotion), b >= 0 && b < 1 ? Math.sin(Math.PI * b) ** 2 : 0));
    if (speaking) {
      // Keep the painted expression while speaking; clearing these layers used
      // to erase the requested smile precisely when her reply became visible.
      if (pose.ParamAIHappy < .25 && pose.ParamAISad < .25)
        pose.ParamMouthOpenY = (Math.sin(now / 120) + 1) * .32;
    }
    return pose;
  }
}
