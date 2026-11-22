// 独立真实浏览器测试：不启动 main、不采集屏幕、不读取持久数据、不访问 AI。
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = path.join(root, "work", "chat-layout-tests");
mkdirSync(artifactRoot, { recursive: true });
const run = mkdtempSync(path.join(artifactRoot, "run-"));
const browser = process.env.PET_TEST_BROWSER || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);
assert.ok(browser, "需要已安装的 Edge/Chrome；本测试不会安装浏览器");

const tauri = `
export class LogicalSize { constructor(width, height) { this.width = width; this.height = height; } }
export class PhysicalPosition { constructor(x, y) { this.x = x; this.y = y; } }
window.testMonitor = { workArea: { position: {x:-1920,y:0}, size:{width:1920,height:1080} } };
window.testScale = 1;
window.testPosition = {x:-1900,y:10};
window.testFitCalls = 0;
export const invoke = async (cmd) => cmd === 'win_ping' ? 'pong' : false;
export const currentMonitor = async () => window.testMonitor;
const win = { label:'mini', outerPosition: async()=>window.testPosition,
  scaleFactor:async()=>window.testScale,
  setSize:async(size)=>{window.testSize = size; window.testFitCalls++;},
  setPosition:async(position)=>{window.testPosition = position;},
  startDragging:async()=>{}, onFocusChanged:async()=>()=>{},
};
export const getCurrentWindow = () => win;
`;
const renderer = `
export async function createPetRenderer(options) {
  const element = document.createElement('div'); element.className = options.wrapClass;
  element.style.background = 'linear-gradient(#f5f5f5, #ededed)';
  return {renderer:{element,play(){}}};
}
export function bindRendererToChat() {}
`;
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><div id="app"></div><script type="module">
import {createApp} from '/src/ui/app.ts';
import {createMiniApp} from '/src/ui/mini.ts';
import {EventBus} from '/src/core/bus.ts';
window.bus=new EventBus();window.fixtureMode=new URLSearchParams(location.search).has('mini')?'mini':'main';
const engine={isThinking:false,isAi:true,ask:async()=>{},sayPet:()=>{}};
const identity={name:'测试桌宠',accentColor:'#4d6bfe'};
const api={'screen-awareness':{snapshot:()=>({enabled:false,status:'off'})}};
if(fixtureMode==='main'){
 document.body.className='desktop';document.documentElement.className='desktop';
 window.wrap=createApp({bus,identity,engine,api,session:{activity:{label:'未选择'},minutesOn:()=>0},personas:{},appearance:{get:()=>({})},changeActivity:()=>{}});
}else{window.wrap=createMiniApp({bus,identity,engine,api,appearance:{get:()=>({})}});wrap.classList.remove('chat-off');}
document.querySelector('#app').append(wrap);
window.fill=(n,long=false)=>{for(let i=0;i<n;i++){bus.emit(i%2?'chat:pet':'chat:user',{text:(i%2?'她的回复':'我的问题')+' '+i+(long?'\\n'+('这是一条用来检查多行气泡的长消息。'.repeat(30)):''),kind:'pet'});}};
window.testReady=true;
</script>`;
const allowed = new Set(["src/ui/screenToggle.ts", "src/ui/mini.ts", "src/ui/app.ts", "src/ui/stageSize.ts", "src/ui/imageInput.ts", "src/ui/screenReadout.ts", "src/ui/screenPopover.ts", "src/ui/dom.ts", "src/ui/chatView.ts",
  "src/ui/speechBubble.ts", "src/ui/miniGeometry.ts", "src/core/bus.ts", "src/desktop.ts", "src/styles.css"]);
allowed.add('src/ui/icons.ts');
allowed.add('src/ui/viewSwitch.ts');
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let body, type = "text/javascript; charset=utf-8";
    if (url.pathname === "/") { body = html; type = "text/html; charset=utf-8"; }
    else if (url.pathname === "/tauri-stub.js") body = tauri;
    else if (url.pathname === "/renderer-stub.js") body = renderer;
    else if(url.pathname === "/panels-stub.js") body = "export const createPanelHost=()=>({root:document.createElement('div'),open(){}})";
    else if(url.pathname === "/config-stub.js") body = "export const getSection=(_n,d)=>d;export const setSection=()=>{}";
    else {
      const name = decodeURIComponent(url.pathname.slice(1));
      if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
      body = readFileSync(path.join(root, name), "utf8");
      if (name.endsWith(".css")) type = "text/css; charset=utf-8";
      else {
        body = ts.transpileModule(body, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
        body = body.replace(/(from\s+["'])([^"']+)(["'])/g, (match, before, spec, after) => {
          if(name === "src/ui/app.ts" && spec === "./panels") return `${before}/panels-stub.js${after}`;
          if(name === "src/ui/stageSize.ts" && spec === "../core/config") return `${before}/config-stub.js${after}`;
          if (spec.startsWith("@tauri-apps/")) return `${before}/tauri-stub.js${after}`;
          if (["src/ui/mini.ts","src/ui/app.ts"].includes(name) && spec === "../render") return `${before}/renderer-stub.js${after}`;
          return spec.startsWith(".") ? `${before}${spec}.ts${after}` : match;
        });
      }
    }
    res.writeHead(200, {"content-type":type}); res.end(body);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${path.join(run,"profile")}`, "about:blank"],
{windowsHide:true,stdio:["ignore","ignore","pipe"]});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const pending = new Map();
const errors = [];
const blockedRequests = [];
try {
  const debuggerUrl = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => reject(Error(`browser exited: ${code}`)));
    const timer = setTimeout(()=>reject(Error("browser startup timeout")),15000);
    child.stderr.on("data", data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(debuggerUrl).port}/json/list`)).json();
  socket = new WebSocket(pages.find(page=>page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  let next = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id); if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text + ": " + (message.params.exceptionDetails.exception?.description || ""));
    if (message.method === "Fetch.requestPaused") {
      const {requestId,request} = message.params;
      const local = request.url.startsWith(origin + "/") || request.url === "about:blank";
      if (!local) blockedRequests.push(request.url);
      void send(local ? "Fetch.continueRequest" : "Fetch.failRequest", local ? {requestId} : {requestId,errorReason:"BlockedByClient"});
    }
  });
  function send(method,params={}) {
    const id = ++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},10000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
  }
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const check = async (expression, message) => assert.ok(await evaluate(expression), message);
  const screenshot = async name => {
    const result = await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(path.join(run,name),Buffer.from(result.data,"base64"));
  };
  const settle = async () => {
    await pause(130);
    const size = await evaluate("window.testSize");
    if (size) await send("Emulation.setDeviceMetricsOverride",{width:Math.round(size.width),height:Math.round(size.height),deviceScaleFactor:1,mobile:false});
    await pause(100);
  };
  await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  for(const mode of ['main','mini']){
    await send('Emulation.setDeviceMetricsOverride',{width:740,height:660,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:origin+(mode==='mini'?'/?mini':'/')});
    for(let i=0;i<100&&!(await evaluate('window.testReady===true'));i++)await pause(50);
    await check('window.testReady===true','actual app initializes: '+errors.join(';'));
    for(const [width,height] of mode==='main'?[[740,660],[420,600],[700,980],[520,620]]:[[360,680],[320,600]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate("document.querySelector('.chat-log').replaceChildren();fill(80,true)");await pause(60);
      if(mode==='main')await evaluate("bus.emit('mind:status',{ok:true,memory:{episodes:234}})");
      for(const stage of mode==='main'?[0,Math.max(120,height-300)]:[0]){
        if(mode==='main')await evaluate(stage?`document.documentElement.style.setProperty('--stage-h','${stage}px')`:"document.documentElement.style.removeProperty('--stage-h')");
        await pause(50);
        const metrics=await evaluate(`(()=>{
          const log=document.querySelector('.chat-log'),input=document.querySelector('.input-row'),status=document.querySelector('.status');
          const r=log.getBoundingClientRect(),ir=input.getBoundingClientRect(),sr=status?.getBoundingClientRect();
          return {log:{top:r.top,bottom:r.bottom,height:r.height},input:{top:ir.top,bottom:ir.bottom,left:ir.left,right:ir.right},
            status:sr?{top:sr.top,bottom:sr.bottom,height:sr.height}:null,scroll:log.scrollHeight>log.clientHeight,
            bubbleNoOverlap:[...log.querySelectorAll('.bubble')].every((el,i,a)=>!i||el.getBoundingClientRect().top>=a[i-1].getBoundingClientRect().bottom-1),
            bubbleKeepsText:[...log.querySelectorAll('.bubble')].every(el=>el.scrollHeight<=el.clientHeight+1),
            childrenClip:getComputedStyle(log).overflowY,headerHeight:document.querySelector('.topbar')?.getBoundingClientRect().height,
            buttonsFit:[...input.querySelectorAll('button,input.chat-inp')].every(el=>{const b=el.getBoundingClientRect();return b.left>=ir.left&&b.right<=ir.right+1})};})()`);
        assert.ok(metrics.bubbleNoOverlap,mode+' bubbles overlap '+JSON.stringify(metrics));
        assert.ok(metrics.bubbleKeepsText,mode+' bubble text is squeezed outside its box '+JSON.stringify(metrics));
        assert.ok(metrics.scroll,mode+' history scrolls, not body');
        assert.ok(metrics.buttonsFit,mode+' image/send/input fit');
        if(mode==='main'){
          assert.ok(metrics.status.height>=20,'status must retain readable height: '+JSON.stringify(metrics));
          assert.ok(metrics.log.top>=metrics.status.bottom-1,'chat cannot overlap status');
          assert.ok(metrics.log.bottom<=metrics.input.top+1,'history cannot overlap input');
          assert.ok(metrics.input.bottom<=height+1,'input remains within window');
          assert.ok(metrics.log.height>=80,'chat still usable after stage resize');
        }
        await evaluate("document.querySelector('.chat-log').scrollTop=0");
        await check("document.querySelector('.chat-log').scrollTop===0",'can scroll to first message');
      }
    }
    await screenshot(mode+'-many-messages.png');
  }
  assert.deepEqual(errors,[],'no runtime errors');
  assert.deepEqual(blockedRequests.filter(url=>new URL(url).hostname!=='me.kis.v2.scr.kaspersky-labs.com'),[],'no application external requests');
  console.log('chat layout: actual main/mini app, 80 long restored messages, status/input separation, bubble height, history scroll, image controls, resized stage and six window sizes passed');
  console.log('Artifacts: '+run);
} finally {
  socket?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.kill();
  await new Promise(resolve=>server.close(resolve));
}
