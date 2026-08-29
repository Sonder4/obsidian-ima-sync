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

export interface TagInfo {
	tag: string;
	count?: number;
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

	private async post<T = Record<string, unknown>>(apiPath: string, body: unknown): Promise<T> {
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
			throw new CgiError(code, String(json.msg ?? `错误码 ${code}`));
		}
		return (json.data ?? {}) as T;
	}

	// ===== 删除（up.ts 真更新用） =====

	/** 删除知识库条目（仅对插件自己上传的 media_id 调用） */
	async delKnowledge(kbId: string, mediaIds: string[]): Promise<void> {
		await this.post("/cgi-bin/knowledge/del_knowledge", {
			knowledge_base_id: kbId,
			media_ids: mediaIds,
		});
	}

	// ===== 修改 =====

	/** 重命名知识条目标题 */
	async renameKnowledge(params: {
		kbId: string;
		mediaId: string;
		title: string;
		folderId?: string;
		mediaType?: number;
	}): Promise<void> {
		await this.post("/cgi-bin/knowledge/rename_knowledge", {
			knowledge_base_id: params.kbId,
			media_id: params.mediaId,
			title: params.title,
			...(params.folderId ? { folder_id: params.folderId } : {}),
			...(params.mediaType !== undefined ? { media_type: params.mediaType } : {}),
		});
	}

	/** 替换知识条目内容：newMedia 需先经 create_media + COS 上传（复用官方流程） */
	async replaceKnowledge(params: {
		kbId: string;
		originMediaId: string;
		folderId?: string;
		newMediaId: string;
		newMediaType: number;
		fileInfo: { contentType: string; cosKey: string; fileName: string; fileSize: number };
	}): Promise<void> {
		await this.post("/cgi-bin/knowledge/replace_knowledge", {
			knowledge_base_id: params.kbId,
			origin_media_id: params.originMediaId,
			...(params.folderId ? { folder_id: params.folderId } : {}),
			replace_info: {
				media_id: params.newMediaId,
				media_type: params.newMediaType,
				file_info: {
					content_type: params.fileInfo.contentType,
					cos_key: params.fileInfo.cosKey,
					file_name: params.fileInfo.fileName,
					file_size: params.fileInfo.fileSize,
				},
			},
		});
	}

	// ===== 标签管理 =====

	/** 知识库标签列表（客户端 getTags 返回 tagInfos） */
	async getTags(kbId: string): Promise<TagInfo[]> {
		const data = await this.post<{ tagInfos?: { tag?: string; used_cnt?: number }[] }>(
			"/cgi-bin/knowledge/get_tags",
			{ knowledge_base_id: kbId },
		);
		return (data.tagInfos ?? []).map((t) => ({ tag: t.tag ?? "", count: t.used_cnt }));
	}

	/** 搜索标签（游标翻页） */
	async searchTags(kbId: string, query: string, cursor = "", limit = 20): Promise<{ tags: string[]; nextCursor: string; isEnd: boolean }> {
		const data = await this.post<{ searchedTags?: { tag?: string }[]; next_cursor?: string; is_end?: boolean }>(
			"/cgi-bin/knowledge/search_tags",
			{ knowledge_base_id: kbId, query, cursor, limit },
		);
		return {
			tags: (data.searchedTags ?? []).map((t) => t.tag ?? ""),
			nextCursor: String(data.next_cursor ?? ""),
			isEnd: !!data.is_end,
		};
	}

	/** 设置单个条目的标签（覆盖式） */
	async updateTags(kbId: string, mediaId: string, tags: string[]): Promise<void> {
		await this.post("/cgi-bin/knowledge/update_tags", {
			knowledge_base_id: kbId,
			media_id: mediaId,
			tags,
		});
	}

	/** 批量设置多个条目的标签；返回每条成败 */
	async batchUpdateTags(kbId: string, mediaIds: string[], tags: string[]): Promise<{ success: string[]; fail: string[] }> {
		const data = await this.post<{ results?: Record<string, { retCode?: number }> }>(
			"/cgi-bin/knowledge/batch_update_tags",
			{ knowledge_base_id: kbId, media_ids: mediaIds, tags },
		);
		const success: string[] = [];
		const fail: string[] = [];
		for (const [mediaId, r] of Object.entries(data.results ?? {})) {
			(Number(r.retCode) === 0 ? success : fail).push(mediaId);
		}
		return { success, fail };
	}

	/** 删除知识库标签 */
	async delTags(kbId: string, tags: string[]): Promise<void> {
		await this.post("/cgi-bin/knowledge/del_tags", { knowledge_base_id: kbId, tags });
	}

	/** 重命名知识库标签 */
	async renameTag(kbId: string, originTag: string, newTag: string): Promise<void> {
		await this.post("/cgi-bin/knowledge/rename_tag", {
			knowledge_base_id: kbId,
			origin_tag: originTag,
			new_tag: newTag,
		});
	}

	// ===== 结构管理 =====

	/** 在知识库中新建文件夹（parentFolderId 省略或传知识库 ID 表示根目录） */
	async createFolder(kbId: string, parentFolderId: string, title: string): Promise<void> {
		await this.post("/cgi-bin/knowledge/create_folder", {
			knowledge_base_id: kbId,
			folder_id: parentFolderId || kbId,
			title,
		});
	}

	/** 置顶/取消置顶条目 */
	async setKnowledgeTop(kbId: string, folderId: string, mediaId: string, isTop: boolean): Promise<void> {
		await this.post("/cgi-bin/knowledge/set_knowledge_top", {
			knowledge_base_id: kbId,
			folder_id: folderId || kbId,
			media_id: mediaId,
			is_top: isTop,
		});
	}

	/** 创建知识库（个人类型按客户端默认字段构造；如失败请按服务端 msg 调整） */
	async createKnowledgeBase(name: string, description = ""): Promise<{ id?: string }> {
		return await this.post<{ id?: string }>("/cgi-bin/knowledge/create_knowledge_base", {
			name,
			...(description ? { description } : {}),
			type: 1,
		});
	}

	// ===== 跨库复制 =====

	/** 跨知识库复制条目（dstFolderId 省略为目标库根目录）；如服务端返回异步任务 ID，将包含在返回值中 */
	async copyKnowledge(params: {
		mediaIds: string[];
		dstKbId: string;
		dstFolderId?: string;
	}): Promise<{ taskId?: string }> {
		return await this.post<{ taskId?: string }>("/cgi-bin/knowledge/copy_knowledge", {
			media_ids: params.mediaIds,
			dst_knowledge_base_id: params.dstKbId,
			...(params.dstFolderId ? { dst_folder_id: params.dstFolderId } : {}),
		});
	}

	/** 取消跨库复制任务 */
	async cancelCrossKbOp(taskId: string): Promise<void> {
		await this.post("/cgi-bin/knowledge/cancel_cross_kb_op", { task_id: taskId });
	}

	/** 测试会话有效性（探测不存在的资源，不产生副作用） */
	async probe(): Promise<{ ok: boolean; message: string }> {
		try {
			await this.delKnowledge("probe_kb_id", ["probe_media_id"]);
			return { ok: true, message: "会话有效（探测请求返回正常）" };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/登录|login|auth|鉴权|权限|ticket|cookie|key/i.test(msg)) {
				return { ok: false, message: `Cookie 无效或已过期：${msg}` };
			}
			// 业务错误（如"知识库不存在"）说明鉴权已通过
			return { ok: true, message: `接口可达，会话有效（探测返回：${msg}）` };
		}
	}
}
