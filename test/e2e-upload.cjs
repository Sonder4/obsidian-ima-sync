// 端到端验证上行链路：create_media → COS PUT（手写签名）→ add_knowledge
// 与插件 src/up.ts 使用完全相同的算法（签名实现已通过 node crypto 参照验证）
//
// 凭证读取优先级（不会硬编码在仓库里）：
//   1. 环境变量 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY
//   2. ~/.config/ima/client_id 与 ~/.config/ima/api_key（与 ima-skill 相同的存放位置）
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCosAuthorization } = require("./cos-test.cjs");

function readCredFile(name) {
	try {
		return fs.readFileSync(path.join(os.homedir(), ".config/ima", name), "utf8").trim();
	} catch {
		return "";
	}
}

const CLIENT_ID = process.env.IMA_OPENAPI_CLIENTID || readCredFile("client_id");
const API_KEY = process.env.IMA_OPENAPI_APIKEY || readCredFile("api_key");
if (!CLIENT_ID || !API_KEY) {
	console.error("缺少凭证：请设置 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY，或在 ~/.config/ima/ 下放置 client_id 与 api_key 文件。");
	process.exit(1);
}
const KB_ID = process.env.IMA_KB_ID;
if (!KB_ID) {
	console.error("缺少目标知识库：请设置 IMA_KB_ID（可先用 ima-skill 的 get_addable_knowledge_base_list 查询）。");
	process.exit(1);
}

function post(apiPath, body) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = https.request(
			{
				hostname: "ima.qq.com",
				path: apiPath,
				method: "POST",
				headers: {
					"ima-openapi-clientid": CLIENT_ID,
					"ima-openapi-apikey": API_KEY,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(data),
				},
			},
			(res) => {
				let buf = "";
				res.on("data", (c) => (buf += c));
				res.on("end", () => resolve(JSON.parse(buf)));
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function cosPut(host, key, body, cred) {
	return new Promise((resolve, reject) => {
		const pathname = `/${key}`;
		const auth = buildCosAuthorization({
			secretId: cred.secret_id,
			secretKey: cred.secret_key,
			pathname,
			host,
			contentLength: body.length,
			startTime: cred.start_time,
			expiredTime: cred.expired_time,
		});
		const req = https.request(
			{
				hostname: host,
				path: pathname,
				method: "PUT",
				headers: {
					"Content-Type": "text/markdown",
					"Content-Length": body.length,
					Authorization: auth,
					"x-cos-security-token": cred.token,
				},
			},
			(res) => {
				let buf = "";
				res.on("data", (c) => (buf += c));
				res.on("end", () => resolve({ status: res.statusCode, body: buf }));
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

(async () => {
	const fileName = "【测试】Obsidian-ima上行同步验证-可删除.md";
	const content = Buffer.from(
		`# Obsidian ↔ ima 上行同步验证\n\n- 本文件由 obsidian-ima-sync 插件开发时的端到端测试创建。\n- 验证时间：${new Date().toISOString()}\n- 确认后可在 ima 客户端中删除本文件。\n`,
		"utf8",
	);

	console.log("1) create_media…");
	const cm = await post("/openapi/wiki/v1/create_media", {
		file_name: fileName,
		file_size: content.length,
		content_type: "text/markdown",
		knowledge_base_id: KB_ID,
		file_ext: "md",
	});
	if (cm.code !== 0) throw new Error("create_media 失败: " + JSON.stringify(cm));
	const cred = cm.data.cos_credential;
	console.log("   media_id =", cm.data.media_id, "| bucket =", cred.bucket_name, cred.region);

	const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
	console.log("2) COS PUT（自定义签名）…");
	const put = await cosPut(host, cred.cos_key, content, cred);
	console.log("   HTTP", put.status);
	if (put.status < 200 || put.status >= 300) throw new Error("COS 上传失败: " + put.body.slice(0, 300));

	console.log("3) add_knowledge…");
	const ak = await post("/openapi/wiki/v1/add_knowledge", {
		media_type: 7,
		media_id: cm.data.media_id,
		title: fileName,
		knowledge_base_id: KB_ID,
		file_info: {
			cos_key: cred.cos_key,
			file_size: content.length,
			last_modify_time: Math.floor(Date.now() / 1000),
			file_name: fileName,
		},
	});
	if (ak.code !== 0) throw new Error("add_knowledge 失败: " + JSON.stringify(ak));
	console.log("   成功，media_id =", ak.data.media_id);
	console.log("\n✅ 上行链路（create_media → COS 签名上传 → add_knowledge）全部打通");
	console.log("   测试文档「" + fileName + "」已进入知识库，可在 ima 客户端中删除。");
})().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
