import { requestUrl } from "obsidian";

// ima 内部 cgi 接口客户端（逆向自 ima 客户端 5.8.6 扩展 + 桌面端真实流量捕获，见 docs/ima-internals.md）
//
// ⚠ 使用边界：
// - 这些端点不在官方 OpenAPI 承诺范围内，腾讯可能随时变更
// - 会话凭证由用户在设置中自愿提供（完整 x-ima-cookie），插件不做任何凭证提取
// - 删除操作只应作用于插件自己上传的文档（见 up.ts 的调用约束）
//
// 实测要点：
// - 认证：x-ima-cookie 需含完整客户端字段（IMA-UID/IMA-TOKEN/IMA-REFRESH-TOKEN/UID-TYPE/TOKEN-TYPE/CLIENT-TYPE=256021 等）
//   + x-ima-bkn = getBkn(IMA-TOKEN)
// - 个人知识库在这些接口中的 knowledge_base_id = 用户 UID（IMA-UID）
// - 内部命名空间与官方 OpenAPI 的媒体 ID 不同：内部上传后由服务端分配 media_id

const CGI_BASE = "https://ima.qq.com";
const WRITER = "knowledge_tab_writer";
const READER = "knowledge_tab_reader";
const FILEMGR = "file_manager";

// x-ima-bkn 算法（与客户端一致，已实测对拍）
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

export interface InternalKnowledge {
	media_id: string;
	media_type: number;
	title: string;
	parent_folder_id?: string;
	tags?: string[];
}

export class ImaCgiClient {
	private uid = "";

	constructor(private cookieString: string) {
		const m = /(?:^|;\s*)IMA-UID=([^;]+)/.exec(this.cookieString.trim());
		if (m) this.uid = m[1].trim();
	}

	get configured(): boolean {
		const c = this.cookieString.trim();
		return c.length > 40 && c.includes("IMA-TOKEN=") && !!this.uid;
	}

	/** 个人知识库的内部 ID = 用户 UID */
	get personalKbId(): string {
		return this.uid;
	}

	private authHeaders(): Record<string, string> {
		let cookie = this.cookieString.trim();
		if (!/(^|;\s*)PLATFORM=/.test(cookie)) cookie += "; PLATFORM=H5";
		if (!/(^|;\s*)CLIENT-TYPE=/.test(cookie)) cookie += "; CLIENT-TYPE=256021";
		const headers: Record<string, string> = {
			"x-ima-cookie": cookie,
			"x-ima-bkn": "0",
			from_browser_ima: "1",
			accept: "application/json",
			"Content-Type": "application/json",
		};
		const m = /(?:^|;\s*)IMA-TOKEN=([^;]+)/.exec(cookie);
		if (m) headers["x-ima-bkn"] = getBkn(m[1].trim());
		return headers;
	}

	private async post<T = Record<string, unknown>>(apiPath: string, body: unknown): Promise<T> {
		const res = await requestUrl({
			url: `${CGI_BASE}/cgi-bin/${apiPath}`,
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
		if (code !== 0) throw new CgiError(code, String(json.msg ?? `错误码 ${code}`));
		return (json.data ?? json) as T;
	}

	// ===== 读取 =====

	/** 标签列表（客户端实际使用 search_tags） */
	async getTags(kbId: string): Promise<{ tag: string }[]> {
		const data = await this.post<{ searched_tags?: { tag_info?: { tag?: string } }[] }>(
			`${READER}/search_tags`,
			{ knowledge_base_id: kbId, query: "", cursor: "", limit: 50 },
		);
		return (data.searched_tags ?? []).map((t) => ({ tag: t.tag_info?.tag ?? "" })).filter((t) => t.tag);
	}

	/** 按标题搜索条目（用于把官方 media_id 解析为内部 media_id） */
	async searchKnowledge(kbId: string, query: string): Promise<InternalKnowledge[]> {
		const data = await this.post<{ searched_knowledge_list?: { knowledge?: Record<string, unknown> }[] }>(
			`${READER}/search_knowledge`,
			{ knowledge_base_id: kbId, query, cursor: "" },
		);
		return (data.searched_knowledge_list ?? []).map((x) => {
			const k = (x.knowledge ?? {}) as Record<string, unknown>;
			return {
				media_id: String(k.media_id ?? ""),
				media_type: Number(k.media_type ?? 0),
				title: String(k.title ?? ""),
				parent_folder_id: k.parent_folder_id ? String(k.parent_folder_id) : undefined,
				tags: Array.isArray(k.tags) ? (k.tags as string[]) : undefined,
			};
		});
	}

	/** 读取知识库根目录列表 */
	async listRoot(kbId: string): Promise<InternalKnowledge[]> {
		const data = await this.post<{ knowledge_list?: Record<string, unknown>[] }>(
			`${READER}/get_knowledge_base_home_page`,
			{ knowledge_base_id: kbId, knowledge_list_req: { knowledge_base_id: kbId, folder_id: kbId, sort_type: 9, need_default_cover: false } },
		);
		return ((data.knowledge_list as Record<string, unknown>[]) ?? []).map((k) => ({
			media_id: String(k.media_id ?? ""),
			media_type: Number(k.media_type ?? 0),
			title: String(k.title ?? ""),
			parent_folder_id: k.parent_folder_id ? String(k.parent_folder_id) : undefined,
		}));
	}

	// ===== 标签管理 =====

	async updateTags(kbId: string, mediaId: string, tags: string[], folderId?: string, mediaType?: number): Promise<void> {
		await this.post(`${WRITER}/update_tags`, {
			knowledge_base_id: kbId,
			media_id: mediaId,
			...(folderId ? { folder_id: folderId } : {}),
			...(mediaType !== undefined ? { media_type: mediaType } : {}),
			tags,
		});
	}

	async delTags(kbId: string, tags: string[]): Promise<void> {
		await this.post(`${WRITER}/del_tags`, { knowledge_base_id: kbId, tags });
	}

	async renameTag(kbId: string, originTag: string, newTag: string): Promise<void> {
		await this.post(`${WRITER}/rename_tag`, { knowledge_base_id: kbId, origin_tag: originTag, new_tag: newTag });
	}

	// ===== 修改 =====

	async renameKnowledge(params: { kbId: string; mediaId: string; title: string; folderId?: string; mediaType?: number }): Promise<void> {
		await this.post(`${WRITER}/rename_knowledge`, {
			knowledge_base_id: params.kbId,
			media_id: params.mediaId,
			title: params.title,
			...(params.folderId ? { folder_id: params.folderId } : {}),
			...(params.mediaType !== undefined ? { media_type: params.mediaType } : {}),
			action: 0,
			is_searching: false,
		});
	}

	// ===== 结构管理 =====

	async createFolder(kbId: string, parentFolderId: string, title: string): Promise<{ mediaId?: string }> {
		const data = await this.post<{ knowledge?: { media_id?: string } }>(`${WRITER}/create_folder`, {
			knowledge_base_id: kbId,
			folder_id: parentFolderId || kbId,
			title,
		});
		return { mediaId: (data.knowledge as { media_id?: string } | undefined)?.media_id };
	}

	async setKnowledgeTop(kbId: string, folderId: string, mediaId: string, isTop: boolean): Promise<void> {
		await this.post(`${WRITER}/set_knowledge_top`, {
			knowledge_base_id: kbId,
			folder_id: folderId || kbId,
			media_id: mediaId,
			is_top: isTop,
		});
	}

	async createKnowledgeBase(name: string): Promise<{ id?: string }> {
		const data = await this.post<{ info?: Record<string, unknown> }>(`${WRITER}/create_knowledge_base`, { name });
		// info 内嵌 basic_info.id 或顶层 id，递归找不到则留空
		const info = data.info as { id?: string; basic_info?: { id?: string } } | undefined;
		return { id: info?.id ?? info?.basic_info?.id };
	}

	async deleteKnowledgeBase(id: string): Promise<void> {
		await this.post(`${WRITER}/delete_knowledge_base`, { id });
	}

	// ===== 删除（文档与文件夹通用；仅对插件可控对象调用） =====

	async delKnowledge(kbId: string, mediaIds: string[]): Promise<void> {
		await this.post(`${WRITER}/del_knowledge`, { knowledge_base_id: kbId, media_ids: mediaIds });
	}

	// ===== 跨库复制 =====

	async copyKnowledge(params: { mediaIds: string[]; dstKbId: string; dstFolderId?: string }): Promise<{ mediaIds?: string[] }> {
		const data = await this.post<{ media_ids?: string[] }>(`${WRITER}/copy_knowledge`, {
			media_ids: params.mediaIds,
			dst_knowledge_base_id: params.dstKbId,
			...(params.dstFolderId ? { dst_folder_id: params.dstFolderId } : {}),
		});
		return { mediaIds: data.media_ids };
	}

	async cancelCrossKbOp(taskId: string): Promise<void> {
		await this.post(`${WRITER}/cancel_cross_kb_op`, { task_id: taskId });
	}

	// ===== 内部上传链路（上传到内部命名空间，文档此后可改名/删除/打标签） =====

	async uploadMarkdown(kbId: string, fileName: string, content: Uint8Array, folderId?: string): Promise<{ mediaId: string }> {
		// 1) create_media 取 COS 凭证（media_type 为字符串枚举）
		const cm = await this.post<{ cos_credential?: Record<string, string> }>(`${FILEMGR}/create_media`, {
			knowledge_base_id: kbId,
			file_name: fileName,
			file_size: content.byteLength,
			content_type: "text/markdown",
			file_ext: "md",
			media_type: "MARKDOWN",
		});
		const cred = cm.cos_credential;
		if (!cred?.cos_key) throw new CgiError(-1, "create_media 未返回上传凭证");

		// 2) COS PUT（签名算法与官方通道相同，已对拍验证）
		await this.cosPut(content, cred, "text/markdown");

		// 3) add_knowledge（服务端根据 cos_key 分配内部 media_id）
		const ak = await this.post<{ media_id?: string }>(`${WRITER}/add_knowledge`, {
			knowledge_base_id: kbId,
			media_type: 7,
			title: fileName,
			...(folderId ? { folder_id: folderId } : {}),
			file_info: {
				cos_key: cred.cos_key,
				file_size: content.byteLength,
				last_modify_time: Math.floor(Date.now() / 1000),
				file_name: fileName,
			},
		});
		const mediaId = ak.media_id ?? "";
		if (!mediaId) throw new CgiError(-1, "add_knowledge 未返回 media_id");
		return { mediaId };
	}

	private async cosPut(content: Uint8Array, cred: Record<string, string>, contentType: string): Promise<void> {
		// 纯 JS SHA-1/HMAC（无 Node 依赖）
		const sig = await import("./cos").then((m) =>
			m.buildCosAuthorization({
				secretId: cred.secret_id,
				secretKey: cred.secret_key,
				pathname: `/${cred.cos_key}`,
				host: `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`,
				contentLength: content.byteLength,
				startTime: Number(cred.start_time),
				expiredTime: Number(cred.expired_time),
			}),
		);
		const res = await requestUrl({
			url: `https://${cred.bucket_name}.cos.${cred.region}.myqcloud.com/${cred.cos_key}`,
			method: "PUT",
			headers: {
				"Content-Type": contentType,
				Authorization: sig,
				"x-cos-security-token": cred.token,
			},
			body: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new CgiError(-1, `COS 上传失败（HTTP ${res.status}）`);
		}
	}

	/** 会话有效性探测（不产生副作用） */
	async probe(): Promise<{ ok: boolean; message: string }> {
		try {
			await this.listRoot(this.uid);
			return { ok: true, message: `会话有效（UID ${this.uid} 的知识库可访问）` };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}
}
