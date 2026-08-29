import { requestUrl } from "obsidian";

// ima 内部 cgi 接口客户端（逆向自 ima 客户端 Web 层，见 docs/ima-internals.md）
//
// ⚠ 使用边界：
// - 这些端点不在官方 OpenAPI 承诺范围内，腾讯可能随时变更
// - 会话凭证由用户在设置中自愿提供（来自用户自己登录的 ima.qq.com），插件不做任何凭证提取
// - 删除操作只应作用于插件自己上传的文档（见 up.ts 的调用约束）

const CGI_BASE = "https://ima.qq.com";

// x-ima-bkn 算法（客户端 Web 层的公开逻辑）：DJB2 变体哈希
export function getBkn(token: string): string {
	try {
		let hash = 5381;
		for (let i = 0; i < token.length; i++) {
			hash += (hash << 5) + token.charCodeAt(i);
		}
		return String(hash & 2147483647);
	} catch {
		return "0";
	}
}

export class CgiError extends Error {
	constructor(
		public code: number,
		message: string,
	) {
		super(message);
	}
}

export class ImaCgiClient {
	constructor(private cookieString: string) {}

	get configured(): boolean {
		return this.cookieString.trim().length > 20 && this.cookieString.includes("=");
	}

	/** 从用户提供的 cookie 串中提取 IMA-TOKEN 并计算 bkn */
	private authHeaders(): Record<string, string> {
		let cookie = this.cookieString.trim();
		// 客户端请求会携带这两个字段；网页 cookie 里缺失时补默认值
		if (!/(^|;\s*)PLATFORM=/.test(cookie)) cookie += "; PLATFORM=H5";
		if (!/(^|;\s*)CLIENT-TYPE=/.test(cookie)) cookie += "; CLIENT-TYPE=H5";

		const headers: Record<string, string> = {
			"x-ima-cookie": cookie,
			from_browser_ima: "1",
			"Content-Type": "application/json",
		};
		const m = /(?:^|;\s*)IMA-TOKEN=([^;]+)/.exec(cookie);
		if (m) headers["x-ima-bkn"] = getBkn(m[1].trim());
		return headers;
	}

	private async post(apiPath: string, body: unknown): Promise<Record<string, unknown>> {
		const res = await requestUrl({
			url: `${CGI_BASE}${apiPath}`,
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body ?? {}),
			throw: false,
		});
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(res.text);
		} catch {
			throw new CgiError(-1, `响应异常（HTTP ${res.status}）：${res.text.slice(0, 100) || "空响应体"}`);
		}
		const code = Number(json.code);
		if (code !== 0) {
			// 常见：登录态失效返回登录相关错误码，此时提示用户更新 cookie
			throw new CgiError(code, String(json.msg ?? `错误码 ${code}`));
		}
		return json;
	}

	/** 删除知识库条目（仅对插件自己上传的 media_id 调用） */
	async delKnowledge(kbId: string, mediaIds: string[]): Promise<void> {
		await this.post("/cgi-bin/knowledge/del_knowledge", {
			knowledge_base_id: kbId,
			media_ids: mediaIds,
		});
	}
}
