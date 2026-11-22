// 独立真实浏览器测试：不启动 main、不采集屏幕、不读取持久数据、不访问 AI。
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = path.join(root, "work", "screen-readout-tests");
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
  element.style.background = 'linear-gradient(#dfe7f5, #c7d4f7)';
  return {renderer:{element,play(){}}};
}
export function bindRendererToChat() {}
`;
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css">
<div id="app"></div><script type="module">
import {createMiniApp} from '/src/ui/mini.ts';
import {createScreenPopover} from '/src/ui/screenPopover.ts';
import {createScreenToggle} from '/src/ui/screenToggle.ts';
import {EventBus} from '/src/core/bus.ts';
import {initDesktopHooks} from '/src/desktop.ts';
window.__TAURI_INTERNALS__ = {};
window.bus = new EventBus();
window.testLayoutEvents = 0;
window.addEventListener('pet:screen-layout',()=>window.testLayoutEvents++);
window.fixture = {enabled:true,status:'watching',title:'代码编辑器 · pet 核对',
 summary:Array.from({length:60},(_,i)=>'第 '+(i+1)+' 行：这是实际选用的 OCR 正文，保留换行与全部文字。').join(String.fromCharCode(10)),
 capturedAt:Date.now()-2000,error:'',scene:'旧版兼容总结',sceneAt:Date.now()-1000,windowId:'test-window',
 aiSummary:'正在编辑桌宠的小窗核对面板。',aiSummaryAt:Date.now()-1000,
 pageType:'coding',activity:'调整屏幕面板的阅读顺序',focus:'语义摘要',understandingAt:Date.now()-500,understandingStatus:'ready',
 screenMoment:{kind:'screen',fact:'核对面板切换为语义视图',subtitle:'测试瞬间',key:'fixture-moment',capturedAt:Date.now()},
 decision:'已过滤工具栏，保留文档正文',rawLineCount:68,keptLineCount:60,filteredLineCount:8};
window.powerState={enabled:localStorage.getItem('fixture-screen-enabled')==='true',status:'off'};
window.powerCalls=[];
const api = {'screen-awareness':{snapshot:()=>new URLSearchParams(location.search).has('snapshot') ? window.fixture : powerState,
 setEnabled:async enabled=>{powerCalls.push(enabled);await new Promise(r=>setTimeout(r,50));powerState={enabled,status:enabled?'waiting':'off'};
 api['screen-awareness']={...api['screen-awareness'],snapshot:()=>powerState};localStorage.setItem('fixture-screen-enabled',String(enabled));bus.emit('screen:status',powerState);}}};
window.testAiCalls = 0;
window.testUploads = []; window.testReports = [];
if(new URLSearchParams(location.search).has('main')) {
 document.body.className='desktop';document.documentElement.className='desktop';
 window.popover=createScreenPopover();
 window.wrap=document.createElement('div');window.wrap.className='pet-app';
 const header=document.createElement('header');header.className='topbar';
 const brand=document.createElement('b');brand.textContent='测试桌宠';header.append(brand,createScreenToggle(bus,api),popover.trigger);
 const chat=document.createElement('div');chat.className='chat';chat.textContent='聊天区域，不应再出现横向屏幕感知栏';
 wrap.append(header,chat,popover.element);document.querySelector('#app').append(wrap);popover.update(fixture);
} else {
 window.wrap = createMiniApp({bus:window.bus,engine:{isThinking:false,ask:async(text,image)=>{window.testAiCalls++;window.testUploads.push({text,image});},sayPet:text=>window.testReports.push(text)},
  identity:{name:'测试桌宠'},api});
 document.querySelector('#app').append(window.wrap);
 await initDesktopHooks();
}
window.testReady = true;
</script>`;

const allowed = new Set(["src/ui/screenToggle.ts", "src/ui/mini.ts", "src/ui/imageInput.ts", "src/ui/screenReadout.ts", "src/ui/screenPopover.ts", "src/ui/dom.ts", "src/ui/chatView.ts",
  "src/ui/speechBubble.ts", "src/ui/miniGeometry.ts", "src/core/bus.ts", "src/desktop.ts", "src/styles.css"]);
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let body, type = "text/javascript; charset=utf-8";
    if (url.pathname === "/") { body = html; type = "text/html; charset=utf-8"; }
    else if (url.pathname === "/tauri-stub.js") body = tauri;
    else if (url.pathname === "/renderer-stub.js") body = renderer;
    else {
      const name = decodeURIComponent(url.pathname.slice(1));
      if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
      body = readFileSync(path.join(root, name), "utf8");
      if (name.endsWith(".css")) type = "text/css; charset=utf-8";
      else {
        body = ts.transpileModule(body, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
        body = body.replace(/(from\s+["'])([^"']+)(["'])/g, (match, before, spec, after) => {
          if (spec.startsWith("@tauri-apps/")) return `${before}/tauri-stub.js${after}`;
          if (name === "src/ui/mini.ts" && spec === "../render") return `${before}/renderer-stub.js${after}`;
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
  await send("Runtime.enable"); await send("Page.enable");
  await send("Fetch.enable",{patterns:[{urlPattern:"*"}]});
  await send("Emulation.setDeviceMetricsOverride",{width:360,height:1000,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:origin});
  for(let i=0;i<100 && !(await evaluate("window.testReady === true"));i++) await pause(50);
  await check("window.testReady", `isolated mini starts: ${errors.join('; ')}`); await settle();
  await check("document.querySelector('.mini-screen-status').textContent === '已关闭'", "initial collection off is explicit");
  await check("getComputedStyle(document.querySelector('.mini-screen')).display === 'none'", "panel initially hides with chat");
  // 实际点击角色，执行 desktop.ts 的开关和尺寸适配。
  await evaluate("document.querySelector('.mini-stage').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:100,clientY:100})); window.dispatchEvent(new MouseEvent('mouseup',{clientX:100,clientY:100}))");
  await settle();
  await check("!wrap.classList.contains('chat-off') && getComputedStyle(document.querySelector('.mini-screen')).display !== 'none'", "character click opens chat and panel");
  await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'self'})");
  await check("document.querySelector('.mini-screen-previous').hidden && document.querySelector('.mini-screen-ocr').textContent !== fixture.summary", "no last reading is invented before a watching event");
  await evaluate("bus.emit('screen:status',fixture)"); await settle();
  await check("document.querySelector('.mini-screen-title').textContent.includes(fixture.title)", "shared window title");
  await check("document.querySelector('.mini-screen-ocr').textContent === fixture.summary", "full actual selected OCR with original newlines");
  await check("fixture.summary.includes(String.fromCharCode(10))", "fixture uses actual multiline text");
  await check("document.querySelector('.mini-screen-ai').textContent === fixture.aiSummary", "AI summary precedence");
  await check("document.querySelector('.mini-screen-reason').textContent.includes(fixture.decision) && document.querySelector('.mini-screen-counts').textContent.includes('过滤 8 行')", "decision and actual counts");
  await check("document.querySelector('.mini-screen-updated').hasAttribute('datetime') && document.querySelector('.mini-screen-captured').textContent.includes(new Date(fixture.capturedAt).toLocaleTimeString('zh-CN',{hour12:false}))", "receive and capture timestamps are separate");
  await check("document.querySelector('.mini-screen-head b').textContent === '她眼中的屏幕' && document.querySelector('.mini-screen-page').textContent === '正在看：代码'", "semantic heading and supplied page type");
  await check("document.querySelector('.mini-screen-activity').textContent === '页面内容：' + fixture.activity && document.querySelector('.mini-screen-focus').textContent.includes(fixture.focus)", "activity and secondary focus come from AI fields");
  await check("!document.querySelector('.mini-screen-details').open && !document.querySelector('.mini-screen-ocr').checkVisibility() && document.querySelector('.mini-screen-ai').checkVisibility()", "details default closed: OCR exists but is not visible; AI stays visible");
  await check("['captured','updated'].every(name=>document.querySelector('.mini-screen-'+name).closest('details') && !document.querySelector('.mini-screen-'+name).checkVisibility())", "full OCR/AI/understanding/receive timestamps are inside closed details only");
  await check("!document.querySelector('.mini-screen-time').closest('details') && document.querySelector('.mini-screen-time').checkVisibility() && document.querySelector('.mini-screen-time').textContent === '画面：'+new Date(fixture.understandingAt).toLocaleTimeString('zh-CN',{hour12:false})+'（最近一次识别）' && document.querySelector('.mini-screen-time').dateTime === new Date(fixture.understandingAt).toISOString()", "main area has one short frame time from usable model, not OCR or receive time");
  await check("getComputedStyle(document.querySelector('.mini-screen')).borderTopColor === 'rgb(227, 222, 214)' && document.querySelector('.mini-screen-focus').textContent === '画面重点：'+fixture.focus", "neutral panel border and page-focused label, not inferred user gaze");
  await check("['title','ocr','reason','counts'].every(name=>document.querySelector('.mini-screen-'+name).closest('details'))", "raw title/OCR/filter/counts only live in native details");
  await check("document.querySelector('.mini-screen-details > summary').textContent === '识别详情（展开核对）'", "native disclosure label");
  await screenshot("compact.png");
  const detailEvents = await evaluate("testLayoutEvents");
  await evaluate("document.querySelector('.mini-screen-details > summary').click()"); await settle();
  await check("document.querySelector('.mini-screen-details').open && document.querySelector('.mini-screen-ocr').checkVisibility()", "native summary opens real OCR for verification");
  assert.ok(await evaluate("testLayoutEvents") > detailEvents, "details toggle notifies desktop layout");
  await check("document.querySelector('.mini-screen-ocr').scrollHeight > document.querySelector('.mini-screen-ocr').clientHeight", "compact OCR is scrollable inside open details");
  await screenshot("details.png");
  await evaluate("document.querySelector('.mini-screen-ocr').scrollTop = 90; bus.emit('screen:status',{...fixture,aiSummary:'AI 后续更新'})");
  await check("document.querySelector('.mini-screen-ocr').scrollTop === 90", "AI-only updates preserve reading position");
  const compact = await evaluate("document.querySelector('.mini-screen-ocr').clientHeight");
  const toggleEvents = await evaluate("testLayoutEvents");
  await evaluate("document.querySelector('.mini-screen-toggle').click()"); await settle();
  assert.ok(await evaluate("testLayoutEvents") > toggleEvents, "OCR toggle notifies desktop layout");
  assert.ok(await evaluate("document.querySelector('.mini-screen-ocr').clientHeight") > compact, "expand increases readable OCR height");
  await check("document.querySelector('.mini-screen-toggle').getAttribute('aria-expanded') === 'true'", "expand accessibility");
  await check("testSize.width >= 360 && document.querySelector('.mini-screen').getBoundingClientRect().bottom <= testSize.height", "fit includes full panel width and height");
  await evaluate("bus.emit('pet:bubble',{text:'主动消息 '.repeat(300),kind:'initiative'})"); await settle();
  await check("!document.querySelector('.mini-bubble').hidden && document.querySelector('.mini-screen').getBoundingClientRect().bottom <= testSize.height", "bubble and expanded panel fit together");
  await check("testPosition.x >= -1920 && testPosition.x + testSize.width <= 0", "negative coordinate monitor clamp");
  await screenshot("expanded-with-bubble.png");
  const fitCalls = await evaluate("testFitCalls"); await pause(250);
  assert.ok((await evaluate("testFitCalls")) - fitCalls < 4, "resize observers settle without a fit loop");
  await evaluate("testMonitor.workArea.size.height=720; testScale=1.5; window.dispatchEvent(new Event('pet:screen-layout'))"); await settle();
  await check("testSize.height <= 480 && document.querySelector('.mini-screen').clientHeight >= 40", "DPI-scaled small work area keeps panel reachable");
  await check("getComputedStyle(wrap).overflowY === 'auto' || document.querySelector('.mini-screen').getBoundingClientRect().bottom <= testSize.height", "small area scroll fallback prevents clipping");
  await evaluate("wrap.scrollTop=wrap.scrollHeight; document.querySelector('.mini-screen').scrollTop=document.querySelector('.mini-screen').scrollHeight");
  await check("document.querySelector('.mini-screen-updated').getBoundingClientRect().bottom <= testSize.height", "timestamps remain reachable in tiny work area");
  await evaluate("testMonitor.workArea.size.height=1080; testScale=1; bus.emit('screen:status',fixture)");
  for (const pauseReason of ["self", "desktop", "shell", "unavailable", "occluded"]) {
    await evaluate(`window.pausePayload={...fixture,status:'paused',title:'',summary:'',aiSummary:'',pauseReason:${JSON.stringify(pauseReason)}}; bus.emit('screen:status',pausePayload)`);
    await check("!document.querySelector('.mini-screen-previous').hidden && document.querySelector('.mini-screen-previous').textContent === '上次读取（旧画面，当前未采集）' && document.querySelector('.mini-screen-ocr').textContent === fixture.summary && document.querySelector('.mini-screen-activity').textContent === '上次页面内容：'+fixture.activity", "safe pause retains clearly labelled UI-only last reading and semantics");
    await check("!document.querySelector('.mini-screen-reason').textContent.includes('敏感')", "desktop/shell/self pauses are not labelled sensitive");
    await check("pausePayload.summary === '' && pausePayload.aiSummary === ''", "UI last reading never mutates shared payload");
  }
  await settle();
  await evaluate("document.querySelector('.mini-screen').scrollTop=0");
  await screenshot("paused-last-reading.png");
  await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'sensitive'})"); await settle();
  await check("!document.querySelector('.mini-screen-ocr').textContent.includes('第 1 行') && !document.querySelector('.mini-screen-ai').textContent.includes(fixture.aiSummary) && !document.querySelector('.mini-screen-title').textContent.includes(fixture.title)", "pause hides stale title/OCR/AI");
  await check("document.querySelector('.mini-screen-reason').textContent.includes('敏感窗口')", "pause reason");
  await check("document.querySelector('.mini-screen-counts').hidden", "sensitive payload does not retain old line counts");
  await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'self'})");
  await check("document.querySelector('.mini-screen-previous').hidden && document.querySelector('.mini-screen-ocr').textContent !== fixture.summary", "sensitive state permanently clears UI last reading");
  await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'upstream-custom-reason'})");
  await check("document.querySelector('.mini-screen-reason').textContent.includes('upstream-custom-reason')", "unknown pause reasons remain visible");
  await evaluate("bus.emit('screen:status',{...fixture,status:'error',error:'窗口读取失败'})");
  await check("document.querySelector('.mini-screen-reason').textContent.includes('窗口读取失败')", "error details");
  await evaluate("bus.emit('screen:status',{...fixture,enabled:false,status:'off'})");
  await check("document.querySelector('.mini-screen-status').textContent === '已关闭' && !document.querySelector('.mini-screen-ocr').textContent.includes('第 1 行')", "disabled state clears old content");
  await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'self'})");
  await check("document.querySelector('.mini-screen-previous').hidden", "disabled state permanently clears UI last reading");
  await evaluate("bus.emit('screen:status',{...fixture,summary:'',aiSummary:'',decision:undefined,rawLineCount:undefined,keptLineCount:0,filteredLineCount:undefined})");
  await check("document.querySelector('.mini-screen-ocr').textContent.includes('本帧未选用') && document.querySelector('.mini-screen-ai').textContent === fixture.scene && document.querySelector('.mini-screen-counts').textContent === '选用 0 行'", "empty OCR, scene compatibility, optional counters including zero");
  await evaluate("bus.emit('screen:status',{...fixture,title:'<img src=x onerror=alert(1)>',summary:'<script>danger()</script>'})");
  await check("document.querySelector('.mini-screen-ocr').textContent === '<script>danger()</script>' && !document.querySelector('.mini-screen script') && !document.querySelector('.mini-screen img')", "screen text renders as plain text");
  // 语义只能来自模型字段；故意使用与分类相矛盾的标题/OCR。
  for (const [pageType, label] of [["game","游戏"],["anime","动画番剧"],["video","视频"],["article","文章网页"],["chat","聊天"],["coding","代码"],["desktop","桌面"],["other","其他页面"],["uncertain","不确定"],["unsupported","不确定"],["__proto__","不确定"]]) {
    await evaluate(`bus.emit('screen:status',{...fixture,title:'代码 VSCode',summary:'游戏 动画 文章 chat',pageType:${JSON.stringify(pageType)},activity:'模型明确提供的活动'})`);
    await check(`document.querySelector('.mini-screen-page').textContent === ${JSON.stringify('正在看：'+label)}`, `supplied ${pageType}, never title/OCR heuristics`);
    await check("document.querySelector('.mini-screen-activity').textContent === '页面内容：模型明确提供的活动'", "activity is not guessed");
  }
  await evaluate("bus.emit('screen:status',{...fixture,aiSummary:'',scene:'',pageType:undefined,activity:undefined,focus:undefined,understandingAt:undefined,understandingStatus:'waiting',screenMoment:undefined})");
  await check("document.querySelector('.mini-screen-page').textContent === '正在看：不确定' && document.querySelector('.mini-screen-ai').textContent === '文字已读取，正在理解画面' && !document.querySelector('.mini-screen-activity').textContent.includes(fixture.activity)", "OCR alone never fabricates an activity or type");
  await check("document.querySelector('.mini-screen-time').dateTime === new Date(fixture.capturedAt).toISOString()", "without usable AI, short frame time uses OCR capture time");
  await evaluate("bus.emit('screen:status',{...fixture,understandingStatus:'waiting'})");
  await check("document.querySelector('.mini-screen-page').textContent === '正在看：不确定' && !document.querySelector('.mini-screen-ai').textContent.includes(fixture.aiSummary) && document.querySelector('.mini-screen-focus').hidden", "explicit waiting does not promote leftover semantic fields");
  await evaluate("bus.emit('screen:status',{...fixture,pageType:'game',understandingStatus:'uncertain',aiSummary:'',scene:'',activity:'',focus:''})");
  await check("document.querySelector('.mini-screen-page').textContent === '正在看：不确定' && document.querySelector('.mini-screen-ai').textContent === '暂时无法理解画面，仅识别到文字'", "uncertain is honest, even with leftover page type");
  await evaluate("bus.emit('screen:status',{...fixture,understandingStatus:'error',understandingError:'测试模型超时'})");
  await check("document.querySelector('.mini-screen-page').textContent === '正在看：不确定' && document.querySelector('.mini-screen-ai').textContent === '暂时无法理解画面，仅识别到文字' && !document.querySelector('.mini-screen-activity').textContent.includes(fixture.activity) && document.querySelector('.mini-screen-reason').textContent.includes('测试模型超时')", "AI failure does not reuse successful activity; technical error stays in details");
  await evaluate("bus.emit('screen:status',{...fixture,understandingStatus:'ready',aiSummaryAt:Date.now()-106000,understandingAt:Date.now()-106000})");
  await check("document.querySelector('.mini-screen-previous').textContent.includes('已过期') && document.querySelector('.mini-screen-page').textContent === '上次看到：代码' && document.querySelector('.mini-screen-activity').textContent.startsWith('上次页面内容：')", "AI older than 105s is explicitly old, never latest");
  await evaluate("window.newCapture=Date.now(); bus.emit('screen:status',{...fixture,capturedAt:newCapture,summary:'同一窗口的新一帧文字',aiSummaryAt:newCapture-3000,understandingAt:newCapture-1000})");
  await check("document.querySelector('.mini-screen-previous').textContent.includes('文字已更新') && document.querySelector('.mini-screen-captured').textContent.includes('文字采集：'+new Date(newCapture).toLocaleTimeString('zh-CN',{hour12:false})) && document.querySelector('.mini-screen-captured').textContent.includes('AI 总结：'+new Date(newCapture-3000).toLocaleTimeString('zh-CN',{hour12:false})) && document.querySelector('.mini-screen-captured').textContent.includes('理解：'+new Date(newCapture-1000).toLocaleTimeString('zh-CN',{hour12:false}))", "same-window different frames retain separate OCR/summary/understanding times");
  await check("document.querySelector('.mini-screen-time').dateTime === new Date(newCapture-1000).toISOString() && document.querySelector('.mini-screen-time').textContent === '画面：'+new Date(newCapture-1000).toLocaleTimeString('zh-CN',{hour12:false})+'（最近一次识别）'", "new OCR never refreshes the visible old AI frame time");
  await evaluate("bus.emit('screen:status',{...fixture,windowId:'other-window',aiSummary:'',scene:'',pageType:undefined,activity:undefined,focus:undefined,understandingAt:undefined,understandingStatus:'waiting',screenMoment:undefined})");
  await check("!document.querySelector('.mini-screen-ai').textContent.includes(fixture.aiSummary) && document.querySelector('.mini-screen-page').textContent === '正在看：不确定'", "another frame/window without AI cannot inherit prior interpretation");
  await evaluate("bus.emit('screen:status',{...fixture,screenMoment:{...fixture.screenMoment,capturedAt:Date.now()-31000}})");
  await check("document.querySelector('.mini-screen-moment').hidden && document.querySelector('.mini-screen-moment').textContent === ''", "moment older than 30s disappears");
  await evaluate("bus.emit('screen:status',{...fixture,screenMoment:{...fixture.screenMoment,capturedAt:Date.now()-29500}})");
  await check("!document.querySelector('.mini-screen-moment').hidden && document.querySelector('.mini-screen-moment').textContent === '刚才的画面：'+fixture.screenMoment.fact", "recent moment fact is visible");
  const momentReceived = await evaluate("document.querySelector('.mini-screen-updated').dateTime");
  await pause(750);
  await check("document.querySelector('.mini-screen-moment').hidden && document.querySelector('.mini-screen-moment').textContent === ''", "moment expires without another broadcast");
  assert.equal(await evaluate("document.querySelector('.mini-screen-updated').dateTime"), momentReceived, "expiry does not forge receive time");
  await evaluate("window.expiringAt=Date.now()-104500; bus.emit('screen:status',{...fixture,capturedAt:expiringAt,aiSummaryAt:expiringAt,understandingAt:expiringAt,screenMoment:undefined})");
  await check("document.querySelector('.mini-screen-previous').hidden", "AI just inside TTL is current");
  await pause(750);
  await check("document.querySelector('.mini-screen-previous').textContent.includes('已过期')", "AI expires at 105s without another broadcast");
  // 关闭/敏感状态即使携带完整旧载荷，也应清空语义、瞬间、计数与 UI 缓存。
  for (const control of [{enabled:true,status:'paused',pauseReason:'sensitive'}, {enabled:false,status:'off'}, {enabled:true,status:'watching',pauseReason:'sensitive'}]) {
    await evaluate("bus.emit('screen:status',fixture)");
    await evaluate(`bus.emit('screen:status',{...fixture,...${JSON.stringify(control)}})`);
    await check("[fixture.aiSummary,fixture.activity,fixture.focus,fixture.screenMoment.fact,fixture.title,fixture.decision,'第 1 行'].every(text=>!document.querySelector('.mini-screen').textContent.includes(text)) && document.querySelector('.mini-screen-counts').textContent === '' && document.querySelector('.mini-screen-focus').hidden && document.querySelector('.mini-screen-moment').hidden", "private/off payload clears every semantic/raw surface");
    await evaluate("bus.emit('screen:status',{...fixture,status:'paused',pauseReason:'self'})");
    await check("document.querySelector('.mini-screen-previous').hidden && !document.querySelector('.mini-screen-ai').textContent.includes(fixture.aiSummary) && !document.querySelector('.mini-screen-ocr').textContent.includes('第 1 行')", "ordinary pause cannot resurrect cleared private/off cache");
  }
  await evaluate("bus.emit('screen:status',fixture); document.querySelector('.mini-screen-details > summary').click()"); await settle();
  await check("!document.querySelector('.mini-screen-details').open && !document.querySelector('.mini-screen-ocr').checkVisibility()", "details collapses again using native summary");
  await check("!document.querySelector('.mini-screen-captured').checkVisibility() && !document.querySelector('.mini-screen-updated').checkVisibility() && document.querySelector('.mini-screen-time').checkVisibility() && testAiCalls === 0", "collapse hides all technical timestamps again; readout never called AI");
  await evaluate("wrap.classList.add('chat-off')"); await settle();
  await check("getComputedStyle(document.querySelector('.mini-screen')).display === 'none'", "close chat hides panel");
  await send("Page.navigate",{url:origin + "/?snapshot"});
  for(let i=0;i<100 && !(await evaluate("window.testReady === true"));i++) await pause(50);
  await check("document.querySelector('.mini-screen-ocr').textContent === fixture.summary", "optional MiniDeps.api loads first snapshot");
  await check("testAiCalls === 0", "readout never calls the chat engine");
  await evaluate("wrap.classList.remove('chat-off')"); await settle();
  const shownHeight = await evaluate("testSize.height");
  await check("document.querySelector('.mini-screen-switch').getAttribute('aria-checked') === 'true'", "screen display switch initially on");
  await evaluate("document.querySelector('.mini-screen-switch').click()"); await settle();
  await check("document.querySelector('.mini-screen').hidden && getComputedStyle(document.querySelector('.mini-screen')).display === 'none'", "switch hides only readout");
  await check("!wrap.classList.contains('chat-off') && testSize.height < " + shownHeight, "chat stays open and window shrinks when readout hides");
  await evaluate("bus.emit('screen:status',fixture)");
  await check("document.querySelector('.mini-screen').hidden && fixture.enabled && testAiCalls === 0", "new observation does not reopen panel or call engine");
  await send("Page.navigate",{url:origin + "/?snapshot"});
  for(let i=0;i<100 && !(await evaluate("window.testReady === true"));i++) await pause(50);
  await check("document.querySelector('.mini-screen').hidden && document.querySelector('.mini-screen-switch').getAttribute('aria-checked') === 'false'", "hidden preference survives reload");
  await evaluate("wrap.classList.remove('chat-off'); document.querySelector('.mini-screen-switch').click()"); await settle();
  await check("!document.querySelector('.mini-screen').hidden && document.querySelector('.mini-screen-ocr').textContent === fixture.summary && localStorage.getItem('desktop-pet.v1.ui.screenReadout') === 'true'", "switch restores latest reading and saves enabled preference");
  await send('Emulation.setDeviceMetricsOverride',{width:430,height:640,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:origin+'/?main'});
  for(let i=0;i<100 && !(await evaluate('window.testReady === true'));i++) await pause(50);
  await check("document.querySelector('.main-screen-readout').hidden && document.querySelector('.main-screen-switch').getAttribute('aria-expanded')==='false'",'main defaults to small closed button');
  await evaluate("document.querySelector('.main-screen-switch').click()");await settle();
  await check("!popover.element.hidden && popover.element.querySelector('.mini-screen-ai').textContent===fixture.aiSummary",'main opens the shared semantic readout');
  await check("!popover.element.querySelector('details').open",'main details folded by default');
  await evaluate("popover.update({...fixture,attentionMode:'work',attentionAt:Date.now(),ocrIntervalMs:1200000,visionIntervalMs:1200000})");
  await check("popover.element.querySelector('.mini-screen-pacing').textContent.includes('20分钟')",'cadence uses readable minutes');
  for(const [width,height] of [[430,640],[320,480],[600,900]]) {
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await settle();
   await check("(()=>{const r=popover.element.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()",'main readout stays within '+width+'x'+height);
  }
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await check("popover.element.hidden && document.activeElement===popover.trigger",'Escape closes and restores button focus');
  await evaluate("popover.trigger.click();document.querySelector('.chat').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await check('popover.element.hidden','click outside closes main readout');
  await evaluate("popover.trigger.click();popover.update({...fixture,status:'paused',pauseReason:'sensitive',summary:'',aiSummary:'',scene:'',title:''})");
  await check("!popover.element.textContent.includes(fixture.aiSummary)",'main clears sensitive old content');
  await evaluate("popover.element.querySelector('.main-screen-close').click()");
  await check('popover.element.hidden && window.testAiCalls===0','readout UI never sends messages or toggles capture');
  await evaluate("document.querySelector('.screen-power').click();document.querySelector('.screen-power').click()");
  await check("document.querySelector('.screen-power').disabled && powerCalls.length===1",'collection switch prevents pending double click');
  await pause(100);
  await check("document.querySelector('.screen-power').textContent==='读屏：开' && powerCalls[0]===true",'main power button really invokes collection API');
  await evaluate("document.querySelector('.screen-power').click()");await pause(100);
  await check("document.querySelector('.screen-power').getAttribute('aria-checked')==='false' && powerCalls[1]===false",'main stops capture separately from hiding readout');
  // Original FileReader bytes through actual mini file picker/paste/drop/send.
  await send('Page.navigate',{url:origin+'/?snapshot'});
  for(let i=0;i<100 && !(await evaluate('window.testReady === true'));i++) await pause(50);
  await evaluate("bus.emit('screen:status',powerState)");
  await check("document.querySelector('.screen-power').textContent==='读屏：关'",'mini has independent real collection switch and reflects persisted off');
  await evaluate(`window.uploadBytes=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
    window.uploadFile=new File([uploadBytes],'original.png',{type:'image/png'});
    window.uploadExpected='data:image/png;base64,'+btoa(String.fromCharCode(...uploadBytes));
    window.pick=document.querySelector('.file-pick');window.transfer=new DataTransfer();transfer.items.add(uploadFile);pick.files=transfer.files;pick.dispatchEvent(new Event('change'));`);
  await pause(100);
  await check("!document.querySelector('.img-preview').hidden && document.querySelector('.img-preview').style.backgroundImage.includes(uploadExpected)",'picker shows exact original bytes');
  await evaluate("document.querySelector('.mini-input .primary').click()");
  await check("testUploads.length===1 && testUploads[0].text==='' && testUploads[0].image===uploadExpected && document.querySelector('.img-preview').hidden",'mini image-only goes to engine uncompressed and clears draft');
  await evaluate("document.querySelector('.chat-inp').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}))");await pause(100);
  await check("!document.querySelector('.img-preview').hidden",'paste accepts image');
  await evaluate("document.querySelector('.img-preview').click()");
  await check("document.querySelector('.img-preview').hidden",'remove discards draft');
  await evaluate("window.dropTransfer=new DataTransfer();dropTransfer.items.add(uploadFile);document.querySelector('.mini-log').dispatchEvent(new DragEvent('drop',{dataTransfer:dropTransfer,bubbles:true,cancelable:true}))");await pause(100);
  await evaluate("document.querySelector('.chat-inp').value='看这里';document.querySelector('.mini-input .primary').click()");
  await check("testUploads[1].text==='看这里' && testUploads[1].image===uploadExpected",'drop preserves original image and accompanying question: '+JSON.stringify(await evaluate('testUploads')));
  await evaluate("window.bad=new DataTransfer();bad.items.add(new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}));pick.files=bad.files;pick.dispatchEvent(new Event('change'))");
  await check("testReports.length===1 && testReports[0].includes('PNG') && document.querySelector('.img-preview').hidden",'unsupported format reports instead of pretending to send');
  await evaluate("pick.files=transfer.files;pick.dispatchEvent(new Event('change'));document.querySelector('.img-preview').click()");await pause(100);
  await check("document.querySelector('.img-preview').hidden",'cancel while FileReader is pending cannot resurrect image');
  console.log('image input: original file/paste/drop, image-only/question send, remove, unsupported format, pending-reader cancel passed');
  assert.ok(!readFileSync(path.join(root,'src/ui/app.ts'),'utf8').includes('class: "screen-awareness"'),'old full-width status stripe removed from actual main app');
  assert.deepEqual(errors, [], "no browser runtime errors");
  // Windows antivirus may inject this script into localhost pages; it remains
  // BLOCKED by the harness, never permitted or disabled in the user's system.
  const applicationExternal = blockedRequests.filter(url=>new URL(url).hostname !== 'me.kis.v2.scr.kaspersky-labs.com');
  assert.deepEqual(applicationExternal, [], "application makes no external requests (antivirus injection stays blocked)");
  if(blockedRequests.length) console.log('Blocked external antivirus injections: '+blockedRequests.length);
  console.log("screen-readout: semantic types/activity/focus, native details, AI/moment TTL, privacy/old frames, snapshot, switch persistence, safe text, desktop fit/DPI/bubble passed");
  console.log(`Screenshots: ${run}`);
  console.log('main readout: button-only default, shared panel, 20min label, three window sizes, outside/Escape/close, privacy and no extra AI calls passed');
} finally {
  socket?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.kill();
  await new Promise(resolve=>server.close(resolve));
}
