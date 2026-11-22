// 提裙小样共用的表情与动作曲线；正式桌宠沿用已验收的小幅动作。
type Pose = Record<string, number>;
export const BASE_POSE = {
 ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,
 ParamEyeLOpen:1,ParamEyeROpen:1,ParamEyeBallX:0,ParamEyeBallY:0,ParamEyeBallForm:0,
 ParamEyeLSmile:0,ParamEyeRSmile:0,
 ParamBrowLY:0,ParamBrowRY:0,ParamBrowLX:0,ParamBrowRX:0,
 ParamBrowLAngle:0,ParamBrowRAngle:0,ParamBrowLForm:0,ParamBrowRForm:0,
 ParamMouthForm:0,ParamMouthOpenY:0,
 ParamBodyAngleX:0,ParamBodyAngleY:0,ParamBodyAngleZ:0,ParamBodyLean:0,
 ParamProportion:0,ParamBreath:0,ParamHairFront:0,ParamHairBack:0,
 ParamAIClosed:0,ParamAIHalf:0,ParamAIHappy:0,ParamAISad:0
};
export const EMOTIONS: Record<string, {name: string; hint: string; pose: Pose}> = {
 cheerful:{name:'开心陪伴',hint:'笑着看向你。',pose:{ParamEyeLOpen:.95,ParamEyeROpen:.95,ParamEyeLSmile:.4,ParamEyeRSmile:.4,ParamBrowLY:.15,ParamBrowRY:.15,ParamBrowLForm:.25,ParamBrowRForm:.25,ParamMouthForm:.9,ParamMouthOpenY:.22,ParamAngleZ:1}},
 neutral:{name:'平静',hint:'安静地陪在你身边。',pose:{}},
 soft:{name:'温柔',hint:'嗯，我在听。',pose:{ParamEyeLOpen:.8,ParamEyeROpen:.8,ParamEyeLSmile:.32,ParamEyeRSmile:.32,ParamBrowLY:.12,ParamBrowRY:.12,ParamBrowLForm:.22,ParamBrowRForm:.22,ParamMouthForm:.65,ParamAngleZ:2}},
 happy:{name:'开心',hint:'见到你，心情都变好了。',pose:{ParamEyeLOpen:.12,ParamEyeROpen:.12,ParamEyeLSmile:1,ParamEyeRSmile:1,ParamBrowLY:.3,ParamBrowRY:.3,ParamBrowLForm:.55,ParamBrowRForm:.55,ParamMouthForm:1,ParamMouthOpenY:.28,ParamAngleY:1,ParamAngleZ:-2}},
 sad:{name:'委屈',hint:'想要一点点安慰。',pose:{ParamEyeLOpen:.7,ParamEyeROpen:.7,ParamBrowLAngle:.95,ParamBrowRAngle:.95,ParamBrowLForm:-.5,ParamBrowRForm:-.5,ParamBrowLY:.18,ParamBrowRY:.18,ParamEyeBallY:-.18,ParamMouthForm:-.85,ParamMouthOpenY:.02,ParamAngleY:-3,ParamAngleZ:1.5}},
 surprised:{name:'惊讶',hint:'诶？真的吗？',pose:{ParamEyeLOpen:1.6,ParamEyeROpen:1.6,ParamBrowLY:.8,ParamBrowRY:.8,ParamBrowLForm:.7,ParamBrowRForm:.7,ParamMouthForm:-.2,ParamMouthOpenY:.62,ParamAngleY:2,ParamBodyLean:-.3}},
 sleepy:{name:'困倦',hint:'再陪你一会儿……',pose:{ParamEyeLOpen:.3,ParamEyeROpen:.25,ParamBrowLY:-.3,ParamBrowRY:-.3,ParamBrowLForm:-.25,ParamBrowRForm:-.25,ParamEyeBallY:-.2,ParamMouthForm:.1,ParamMouthOpenY:.04,ParamAngleY:-4,ParamAngleZ:3}}
};
export function expressionPose(id='neutral',intensity=1,ai=true): Pose {
 const pose: Pose={...BASE_POSE},e=EMOTIONS[id]||EMOTIONS.neutral;
 for(const [key,value] of Object.entries(e.pose))pose[key]+= (value-pose[key])*intensity;
 if(ai&&['happy','sad','sleepy'].includes(id)){
  for(const key of Object.keys(pose))if(/^Param(Eye|Brow|Mouth)/.test(key))pose[key]=BASE_POSE[key];
  if(id==='happy'){pose.ParamAIClosed=intensity;pose.ParamAIHappy=intensity;}
  if(id==='sad')pose.ParamAISad=intensity;
  if(id==='sleepy'){pose.ParamAIHalf=intensity;pose.ParamBrowLY=-.15*intensity;pose.ParamBrowRY=-.15*intensity;}
 }
 return pose;
}
export function applyBlink(pose: Pose,blink:number,ai=true){
 if(ai){
  // At the half-to-closed interval the half frame stays opaque under the closed frame.
  pose.ParamAIHalf=Math.max(pose.ParamAIHalf,Math.min(1,blink*2));
  pose.ParamAIClosed=Math.max(pose.ParamAIClosed,Math.max(0,blink*2-1));
 }else{pose.ParamEyeLOpen*=1-blink;pose.ParamEyeROpen*=1-blink;}
 return pose;
}
export function expressionFrame(expression: Pose,ai=true): Pose {
 const pose={...expression};
 if(ai){const close=pose.ParamAIClosed;pose.ParamAIClosed=0;applyBlink(pose,close,true);}
 return pose;
}
export function idlePose(t,{body=true,amount=1,emotion='neutral'}={}){
 const s=emotion==='sleepy'?.5:emotion==='surprised'?.65:1;
 const p={ParamAngleX:Math.sin(t*Math.PI/4)*5*s,ParamAngleY:Math.sin(t*Math.PI/2)*1.4*s,
  ParamAngleZ:Math.sin(t*Math.PI/4)*.8*s,ParamEyeBallX:Math.sin(t*Math.PI/4)*.12,
  ParamHairFront:Math.sin(t*Math.PI/4-.4)*.065,ParamHairBack:Math.sin(t*Math.PI/4-.8)*.075};
 if(body)Object.assign(p,{ParamBodyAngleX:Math.sin(t*Math.PI/4)*1.8*amount,
  ParamBodyAngleZ:Math.sin(t*Math.PI/4+.3)*1.1*amount,
  ParamBodyAngleY:Math.sin(t*Math.PI/2)*.3*amount,
  ParamBodyLean:Math.sin(t*Math.PI/4-.4)*.45*amount,
  ParamBreath:(.4-Math.cos(t*Math.PI/2)*.25)*amount});
 return p;
}
export function blinkAmount(t,emotion='neutral'){
 const period=emotion==='sleepy'?4.8:6.2,duration=emotion==='sleepy'?.55:.28;
 const x=((t+period-1.8)%period)/duration;
 return x<=1?Math.sin(Math.PI*x)**2:0;
}
export function blendPose(current: Pose,target: Pose,dt:number): Pose {
 const a=1-Math.exp(-Math.min(.1,Math.max(0,dt))*7);
 return Object.fromEntries(Object.keys(BASE_POSE).map(k=>[k,current[k]+(target[k]-current[k])*a]));
}
