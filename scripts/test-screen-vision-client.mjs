import assert from 'node:assert/strict';
import {fileURLToPath}from'node:url';import{tsLoader}from'./test-utils.mjs';
let config={baseUrl:'https://configured.invalid/v1',apiKey:'local-test-key',model:'configured-model'},request;
let usable=false;
const{describeImage}=tsLoader({
 '../core/config':{getSection:()=>config},
 '../mind/client':{mindUsable:async()=>usable,mindCfg:()=>({url:'http://127.0.0.1:8430',token:'mind-test-token'})},
},{fetch:async(url,opts)=>{request={url,opts,body:JSON.parse(opts.body)};return{ok:true,json:async()=>url.includes('/v1/vision')?{text:'mind summary'}:{choices:[{message:{content:'configured summary'}}]}};}})(fileURLToPath(new URL('../src/chat/vision.ts',import.meta.url)));
assert.equal(await describeImage('synthetic-base64'),'configured summary');
assert.equal(request.body.model,'configured-model');assert.equal(request.url,'https://configured.invalid/v1/chat/completions');
assert.ok(request.body.max_tokens>=500,'JSON预算充足');
config={...config,visionModel:'explicit-vision'};await describeImage('synthetic-base64');assert.equal(request.body.model,'explicit-vision');
config={...config,apiKey:''};usable=true;assert.equal(await describeImage('synthetic-base64'),'mind summary');assert.equal(request.url,'http://127.0.0.1:8430/v1/vision');
assert.ok(!Object.hasOwn(request.body,'model'),'服务端使用其独立配置，不被前端硬编码覆盖');
console.log('vision client: 本地配置模型、显式视觉模型、JSON预算、mind视觉路由通过');
const {screenObservationError}=tsLoader()(fileURLToPath(new URL('../src/chat/screenObservation.ts',import.meta.url)));
assert.match(screenObservationError(new Error('编码 JPEG 失败：The encoder does not support Rgba8')),/本地截图编码失败/);
assert.doesNotMatch(screenObservationError(new Error('编码 JPEG 失败：The encoder does not support Rgba8')),/视觉服务不支持/);
