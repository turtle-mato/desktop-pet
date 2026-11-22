// Local, author-editable dialogue skill. Reload after edits; no model call or memory write.
import * as fs from "node:fs";
import { P } from "./paths.ts";
let cached: {path:string;stamp:string;text:string}|undefined;
export function dialogueSkill(): string {
  const file=P.dialogueSkill;
  if (!file) return "";
  try {
    const info=fs.statSync(file);
    if(!info.isFile() || info.size>32_000)return "";
    const stamp=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if(cached?.path===file && cached.stamp===stamp)return cached.text;
    const body=fs.readFileSync(file,"utf8").replace(/^\uFEFF/,"").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,"").trim();
    if(!body || body.length>8000)return "";
    const text=`【对话skill：接梗与轻抗议】\n${body}`;
    cached={path:file,stamp,text};return text;
  }catch{return "";}
}
