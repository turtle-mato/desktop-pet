// 纯规则 fixture：不截图、不调用模型、不写聊天/人格/记忆。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsLoader } from "./test-utils.mjs";

const { normalizeScreen, screenContent } = tsLoader()(fileURLToPath(new URL("../src/chat/screenContext.ts", import.meta.url)));
const line = (text, left = 300, top = 200, width = 650, height = 24) => ({ text, left, top, width, height });
const frame = (lines, patch = {}) => ({ title: "阅读窗口", width: 1200, height: 800, lines, ...patch });
const article = [
  "屏幕文字筛选需要先辨认真实正文，再排除窗口边缘那些与当前阅读主题无关的导航信息。",
  "教程中的文件、编辑、查看等菜单名称属于讲解内容，不能因为出现这些词就删除整段正文。",
  "这段中文说明保留原来的阅读顺序与换行，只把明确的噪声以及重复识别结果排除在外。",
];
const body = article.map((text, i) => line(text, 300, 200 + i * 50));
const fixtures = [];
function fixture(name, raw, expected, extra = () => {}) { fixtures.push({ name, raw, expected, extra }); }

fixture("浏览器工具栏、侧栏与正文", frame([
  line("文件 编辑 查看 历史 书签 工具 帮助", 5, 5, 550),
  line("https://example.test/article", 160, 50, 700),
  line("首页", 20, 160, 70), line("收藏", 20, 200, 70),
  ...body, line("12:30", 1100, 740, 60), line("第 2 页 / 共 8 页", 500, 770, 160),
], { title: "阅读 - Google Chrome", windowClass: "Chrome_WidgetWin_1", maskedRegions: 2 }), article.join("\n"),
  result => { assert.match(result.decision, /抹白 2 个/); assert.match(result.decision, /边缘短导航或侧栏/); });

const code = [
  'import { normalizeScreen, screenFingerprint } from "./screenContext";',
  'export function selectVisibleBody(snapshot: ScreenSnapshot) {',
  'return normalizeScreen(snapshot).summary.split("\\n");',
  '}',
];
fixture("编辑器菜单、资源树、状态栏与代码", frame([
  line("File Edit Selection View Go Run Terminal Help", 10, 5, 650),
  line("EXPLORER", 20, 120, 120), line("src", 30, 160, 50),
  line("screenContext.ts", 40, 200, 180),
  ...code.map((text, i) => line(text, 300, 180 + i * 40)),
  line("Ln 12, Col 4", 500, 775, 130, 20),
], { title: "screenContext.ts - Visual Studio Code", windowClass: "Chrome_WidgetWin_1" }), code.slice(0, -1).join("\n"));
fixture("教程正文提及菜单不误删", frame([
  ...body, line("文件 编辑 查看 运行", 300, 400, 260),
  line("点击文件菜单，再选择编辑选项，可以看到工具栏中的查看按钮。", 300, 440),
]), [...article, "文件 编辑 查看 运行", "点击文件菜单，再选择编辑选项，可以看到工具栏中的查看按钮。"].join("\n"));
fixture("已过滤工具栏不能占用正文去重键", frame([
  line("File Edit View Go Run Help", 5, 5, 500),
  ...body, line("File Edit View Go Run Help", 300, 450, 500),
]), [...article, "File Edit View Go Run Help"].join("\n"));
fixture("正文左对齐短标题不当成侧栏", frame([
  line("如何阅读", 30, 140, 100),
  ...article.map((text, i) => line(text, 30, 220 + i * 40, 900)),
]), ["如何阅读", ...article].join("\n"));
fixture("目录与正文同名标题不能一起删除", frame([
  line("如何阅读", 20, 140, 100), line("如何阅读", 300, 140, 100), ...body,
]), ["如何阅读", ...article].join("\n"));
fixture("相同高度分离的浏览器按钮", frame([
  line("后退", 5, 20, 40), line("前进", 60, 20, 40), ...body,
]), article.join("\n"));
fixture("几何正文证据不足不删除短文本", frame([
  line("今日待办", 20, 150, 100), line("买牛奶", 20, 200, 100), line("写代码", 300, 230, 100),
]), "今日待办\n买牛奶\n写代码", result => assert.match(result.decision, /正文证据不足/));
fixture("实质短句与单字保留", { title: "便签", text: "修复空指针\n稍后喝水\n好" }, "修复空指针\n稍后喝水\n好");
fixture("游戏HUD少字不能编造正文", frame([
  line("HP 100/100", 20, 100, 130), line("FPS: 60", 1050, 30, 130),
  line("Score 250", 500, 10, 150), line("12:30", 1100, 750, 60),
], { title: "游戏" }), "", result => assert.match(result.decision, /没有可靠文字.*不猜测活动/));
fixture("游戏内明确短指令保留", frame([
  line("HP 100 MP 20 FPS 60", 20, 20, 270), line("按 E 打开宝箱", 400, 500, 200),
], { title: "游戏" }), "按 E 打开宝箱");
fixture("空白画面", { title: "画布", text: "" }, "", result => assert.equal(result.rawLineCount, 0));
fixture("只有空白与标点", { title: "空白", text: "  \n---\n•••\n!!!\n" }, "");
fixture("重复乱码时间页码", { title: "阅读", text: "有效正文内容\n有效正文内容\n������\nab����cd\n09:21:32\n第 3 页\n2 / 10\nPage 2 of 8\n123\n!!!\n下一行仍然保留" }, "有效正文内容\n下一行仍然保留");
fixture("中文文章顺序换行", frame(body), article.join("\n"));
fixture("text旧格式含CRLF兼容", { title: "编辑器", text: "第一行内容\r\n密码：不能泄露\r\n第二行内容\r\n第一行内容" }, "第一行内容\n第二行内容");
fixture("旧格式顶部菜单不占12行", { title: "编辑器", text: "File\nEdit\nSelection\nView\nGo\nRun\nTerminal\nHelp\n" + article.join("\n") }, article.join("\n"));
fixture("整行敏感过滤后保留非敏感内容", frame([
  line("这行开头不能留下 " + "无害文本".repeat(220) + " token=hidden-value"), ...body,
]), article.join("\n"), result => assert.match(result.decision, /敏感信息 1 行/));
fixture("敏感标题整体阻断", { title: "银行登录", text: "不能作为观察", maskedRegions: 1 }, "", result => {
  assert.equal(result.blocked, true); assert.equal(result.title, ""); assert.match(result.decision, /敏感/);
});
fixture("标题截断前检查敏感", { title: "正常标题".repeat(40) + "password", text: "不可展示" }, "", result => assert.equal(result.blocked, true));
fixture("lines优先且不拼接旧text", frame([line("这是当前行")], { text: "上一帧内容\n密码 stale" }), "这是当前行");
fixture("空lines明确表示无文字", frame([], { text: "不能使用旧文本" }), "");
fixture("缺少截图尺寸时保守保留", { title: "文章", lines: [line("导航", 5, 20, 60), ...body] }, ["导航", ...article].join("\n"));
fixture("非法几何不用于侧栏推断", frame([line("保留短句", -10, 20, 80), ...body]), ["保留短句", ...article].join("\n"));
fixture("非有限几何保守保留", frame([line("仍是短句", NaN, 20, 80), ...body]), ["仍是短句", ...article].join("\n"));
fixture("不擅自重排OCR原始顺序", frame([body[2], body[0], body[1]]), [article[2], article[0], article[1]].join("\n"));

const many = Array.from({ length: 15 }, (_, i) => `第${i + 1}段正文说明：每个原始识别行都保持原有顺序，以便按原行解释筛选数量。`);
fixture("12行上限按原行计数", { title: "长文", text: many.join("\n") }, many.slice(0, 12).join("\n"), result => {
  assert.equal(result.rawLineCount, 15); assert.equal(result.keptLineCount, 12); assert.equal(result.filteredLineCount, 3);
});
const long = "这是同一个很长的原始识别行。".repeat(90);
fixture("900字上限不按块乱计数", { title: "长文", text: long + "\n后面的内容" }, long.slice(0, 900), result => {
  assert.equal(result.keptLineCount, 1); assert.equal(result.filteredLineCount, 1); assert.match(result.decision, /限长/);
});
fixture("前15行工具栏不能挤走正文", frame([
  ...Array.from({ length: 15 }, (_, i) => line(["File", "Edit", "View", "Go", "Help"][i % 5], i * 60, 10, 50)),
  ...body,
]), article.join("\n"));
const nativeLines = [
  ...Array.from({ length: 177 }, () => line("File Edit Selection View Go Run Terminal Help", 5, 5, 650)),
  ...body,
];
fixture("180行lines优先，text截断后正文仍保留", frame(nativeLines, {
  text: nativeLines.map(row => row.text).join("\n").slice(0, 3000),
}), article.join("\n"), result => {
  assert.equal(result.rawLineCount, 180); assert.equal(result.filteredLineCount, 177);
});

for (const [reason, explanation] of Object.entries({ self: /自身/, desktop: /桌面/, shell: /任务栏|系统外壳/, unavailable: /没有可采集/, occluded: /遮挡.*80%/ })) {
  fixture(`原生暂停：${reason}`, frame(body, { title: "银行登录", pauseReason: reason, maskedRegions: 3 }), "", result => {
    assert.equal(result.title, ""); assert.equal(result.blocked, false, "原生原因优先于敏感标题");
    assert.match(result.decision, explanation); assert.doesNotMatch(result.decision, /敏感/);
    assert.match(result.decision, /抹白 3 个/);
  });
}
fixture("未知暂停原因保守清空", frame(body, { pauseReason: "future-reason" }), "", result => assert.match(result.decision, /暂不可采集/));

for (const { name, raw, expected, extra } of fixtures) {
  try {
    const result = normalizeScreen(raw);
    assert.equal(result.summary, expected, name);
    const count = Array.isArray(raw.lines) ? raw.lines.length : raw.text ? raw.text.split(/\r\n?|\n/).length : 0;
    assert.equal(result.rawLineCount, count);
    assert.equal(result.keptLineCount, expected ? expected.split("\n").length : 0);
    assert.equal(result.filteredLineCount, count - result.keptLineCount);
    assert.ok(result.summary.length <= 900 && result.keptLineCount <= 12);
    assert.ok(result.decision.length > 0);
    extra(result);
  } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

const at = 1_800_000_000_000;
const normalized = normalizeScreen(frame(body));
const screen = { ...normalized, enabled: true, status: "watching", capturedAt: at };
assert.match(screenContent(screen, at), /已筛选，保留原文顺序/);
assert.equal(screenContent({ ...screen, status: "paused" }, at), "");
assert.equal(screenContent({ ...screen, enabled: false }, at), "");
assert.match(screenContent({ ...screen, summary: "", aiSummary: "画面上可见蓝色图形", aiSummaryAt: at }, at), /没有可靠文字.*不猜测用户活动/);
assert.equal(screenContent({ ...screen, summary: "" }, at), "");
console.log(`screen-selection: ${fixtures.length} 个场景及短期上下文隔离通过（纯规则，无模型请求）`);
