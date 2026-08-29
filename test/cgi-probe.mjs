// 用网页会话 token 实测 cgi 接口（与插件 src/cgi.ts 同款算法）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sess = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/ima/web_session.json"), "utf8")).accountInfo;
const KB = "ZPfqn-hz2-w1iNsJc7WqB0XxMS3EAV2hexWWQA0Jc84=";

function getBkn(token) {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) hash += (hash << 5) + token.charCodeAt(i);
  return String(hash & 2147483647);
}

function cookieString() {
  return `IMA-TOKEN=${sess.token}; PLATFORM=H5; CLIENT-TYPE=H5; uid=${sess.uid}`;
}

async function post(apiPath, body) {
  const res = await fetch(`https://ima.qq.com${apiPath}`, {
    method: "POST",
    headers: {
      "x-ima-cookie": cookieString(),
      "x-ima-bkn": getBkn(sess.token),
      from_browser_ima: "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 200) };
}

console.log("1) get_tags →", JSON.stringify((await post("/cgi-bin/knowledge/get_tags", { knowledge_base_id: KB })).json)?.data?.tagInfos?.slice(0, 5) ?? (await post("/cgi-bin/knowledge/get_tags", { knowledge_base_id: KB })).text);
const probe = await post("/cgi-bin/knowledge/del_knowledge", { knowledge_base_id: "probe_kb", media_ids: ["probe_media"] });
console.log("2) del_knowledge 探测 →", `HTTP ${probe.status}`, JSON.stringify(probe.json ?? probe.text));
