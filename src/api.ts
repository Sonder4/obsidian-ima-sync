import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
	AddableKbListData,
	AddKnowledgeData,
	CheckRepeatedNamesResult,
	CreateMediaData,
	FileInfoParam,
	ImaResponse,
	KnowledgeListData,
	MediaInfoData,
	NoteBookInfo,
} from "./types";

const BASE_URL = "https://ima.qq.com";
// ima 建议串行节流（约 2 QPS），并在频控时退避重试
const MIN_INTERVAL_MS = 600;
const RETRY_DELAYS_MS = [2000, 4000, 8000];
// 这些错误码可重试：110010 下游网络错误 / 110013 客户端取消 / 110021 请求频控 / 20002 apiKey 限频
const RETRYABLE_CODES = new Set([110010, 110013, 110021, 20002]);

export class ImaApiError extends Error {
	constructor(
		public code: number,
		public apiMsg: string,
	) {
		super(`IMA API 错误 ${code}: ${apiMsg}`);
	}
}

/** 串行节流器：保证请求间隔不低于 MIN_INTERVAL_MS */
class RateLimiter {
	private chain: Promise<void> = Promise.resolve();
	private lastAt = 0;

	run<T>(fn: () => Promise<T>): Promise<T> {
		const task = this.chain.then(async () => {
			const wait = MIN_INTERVAL_MS - (Date.now() - this.lastAt);
			if (wait > 0) await sleep(wait);
			this.lastAt = Date.now();
		});
		this.chain = task.catch(() => {});
		return task.then(fn);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ImaClient {
	private limiter = new RateLimiter();

	constructor(
		public clientId: string,
		public apiKey: string,
	) {}

	get configured(): boolean {
		return !!this.clientId && !!this.apiKey;
	}

	private async rawPost(apiPath: string, body: unknown): Promise<ImaResponse> {
		const param: RequestUrlParam = {
			url: `${BASE_URL}${apiPath}`,
			method: "POST",
			contentType: "application/json",
			headers: {
				"ima-openapi-clientid": this.clientId,
				"ima-openapi-apikey": this.apiKey,
			},
			body: JSON.stringify(body ?? {}),
			throw: false,
		};
		const res = await requestUrl(param);
		const text = res.text;
		let json: ImaResponse;
		try {
			json = JSON.parse(text) as ImaResponse;
		} catch {
			throw new ImaApiError(-1, `响应不是合法 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
		}
		return json;
	}

	/** POST + 限流 + 业务错误判定 + 频控退避重试 */
	private async post<T>(apiPath: string, body: unknown): Promise<T> {
		return this.limiter.run(async () => {
			let lastErr: ImaApiError | null = null;
			for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
				let json: ImaResponse;
				try {
					json = await this.rawPost(apiPath, body);
				} catch (err) {
					// 网络层错误：可重试
					lastErr = new ImaApiError(-1, `网络请求失败：${(err as Error)?.message ?? err}`);
					if (attempt < RETRY_DELAYS_MS.length) {
						await sleep(RETRY_DELAYS_MS[attempt]);
						continue;
					}
					throw lastErr;
				}
				if (json.code === 0) return json.data as T;
				lastErr = new ImaApiError(json.code, json.msg || "未知错误");
				if (RETRYABLE_CODES.has(json.code) && attempt < RETRY_DELAYS_MS.length) {
					await sleep(RETRY_DELAYS_MS[attempt]);
					continue;
				}
				throw lastErr;
			}
			throw lastErr ?? new ImaApiError(-1, "未知错误");
		});
	}

	// ---- 知识库 (/openapi/wiki/v1) ----

	/** 列出当前凭证可添加内容的知识库（设置页勾选来源） */
	async getAddableKbList(): Promise<{ id: string; name: string }[]> {
		const out: { id: string; name: string }[] = [];
		let cursor = "";
		for (let i = 0; i < 100; i++) {
			const data = await this.post<AddableKbListData>("/openapi/wiki/v1/get_addable_knowledge_base_list", {
				cursor,
				limit: 50,
			});
			out.push(...(data.addable_knowledge_base_list ?? []));
			if (data.is_end || !data.next_cursor) break;
			cursor = data.next_cursor;
		}
		return out;
	}

	/** 浏览知识库内容（含文件夹，media_type=99）。folderId 省略为根目录。 */
	async *iterateKnowledgeList(kbId: string, folderId?: string): AsyncGenerator<KnowledgeListData> {
		let cursor = "";
		for (let i = 0; i < 10000; i++) {
			const data = await this.post<KnowledgeListData>("/openapi/wiki/v1/get_knowledge_list", {
				cursor,
				limit: 50,
				knowledge_base_id: kbId,
				...(folderId ? { folder_id: folderId } : {}),
			});
			yield data;
			if (data.is_end || !data.next_cursor) break;
			cursor = data.next_cursor;
		}
	}

	async getMediaInfo(mediaId: string): Promise<MediaInfoData> {
		return this.post<MediaInfoData>("/openapi/wiki/v1/get_media_info", { media_id: mediaId });
	}

	async checkRepeatedNames(
		kbId: string,
		names: { name: string; media_type: number }[],
		folderId?: string,
	): Promise<CheckRepeatedNamesResult[]> {
		const data = await this.post<{ results: CheckRepeatedNamesResult[] }>(
			"/openapi/wiki/v1/check_repeated_names",
			{
				knowledge_base_id: kbId,
				params: names,
				...(folderId ? { folder_id: folderId } : {}),
			},
		);
		return data.results ?? [];
	}

	async createMedia(params: {
		file_name: string;
		file_size: number;
		content_type: string;
		knowledge_base_id: string;
		file_ext: string;
	}): Promise<CreateMediaData> {
		return this.post<CreateMediaData>("/openapi/wiki/v1/create_media", params);
	}

	async addKnowledge(params: {
		media_type: number;
		media_id?: string;
		title: string;
		knowledge_base_id: string;
		folder_id?: string;
		file_info?: FileInfoParam;
	}): Promise<AddKnowledgeData> {
		return this.post<AddKnowledgeData>("/openapi/wiki/v1/add_knowledge", params);
	}

	// ---- 笔记 (/openapi/note/v1) ----

	async listNote(folderId = "", cursor = "", limit = 20): Promise<{ notes: NoteBookInfo[]; isEnd: boolean }> {
		const data = await this.post<{ note_book_list: NoteBookInfo[]; is_end: boolean }>(
			"/openapi/note/v1/list_note",
			{ folder_id: folderId, cursor, limit },
		);
		return { notes: data.note_book_list ?? [], isEnd: !!data.is_end };
	}

	async getNoteContent(noteId: string): Promise<string> {
		// target_content_format: 0=PLAINTEXT（文档标注 MARKDOWN 不支持，故取纯文本）
		const data = await this.post<{ content: string }>("/openapi/note/v1/get_doc_content", {
			note_id: noteId,
			target_content_format: 0,
		});
		return data.content ?? "";
	}
}
