import { normalizePath, requestUrl, TFile, type App } from "obsidian";
import type { ImaClient } from "./api";
import { buildFrontmatter, htmlToMarkdown } from "./convert";
import { MediaType, type KnowledgeListItem, type MediaInfoData } from "./types";
import { dedupePath, ensureFolder, extFrom, joinPath, sanitizeFilename, showErr } from "./util";
import type { DownIndexEntry, ImaSyncSettings } from "./settings";

export interface SyncSummary {
	created: number;
	skipped: number;
	failed: number;
	notes: string[];
}

const MEDIA_TYPE_NAMES: Record<number, string> = {
	1: "PDF",
	2: "网页",
	3: "Word",
	4: "PPT",
	5: "Excel",
	6: "微信文章",
	7: "Markdown",
	9: "图片",
	11: "笔记",
	13: "TXT",
	14: "Xmind",
	15: "录音",
	20: "HTML",
	21: "EPUB",
};

function typeLabel(t: number): string {
	return MEDIA_TYPE_NAMES[t] ?? `类型${t}`;
}

export class DownSync {
	constructor(
		private app: App,
		private client: ImaClient,
		private settings: ImaSyncSettings,
	) {}

	/** 下行所有勾选的知识库 */
	async syncKbs(onProgress?: (msg: string) => void): Promise<SyncSummary> {
		const summary: SyncSummary = { created: 0, skipped: 0, failed: 0, notes: [] };
		for (const kbId of this.settings.selectedKbIds) {
			const root = this.settings.kbFolders[kbId] || "20-ima/未命名知识库";
			await ensureFolder(this.app, root);
			onProgress?.(`知识库 ${root}`);
			await this.walk(kbId, undefined, root, summary, onProgress, 0);
		}
		return summary;
	}

	/** 递归遍历知识库（文件夹 media_type=99，实测 folder 的 media_id 可作为 folder_id） */
	private async walk(
		kbId: string,
		folderId: string | undefined,
		localDir: string,
		summary: SyncSummary,
		onProgress?: (msg: string) => void,
		depth = 0,
	): Promise<void> {
		if (depth > 20) return;
		try {
			for await (const page of this.client.iterateKnowledgeList(kbId, folderId)) {
				for (const item of page.knowledge_list) {
					if (item.media_type === MediaType.FOLDER) {
						const sub = joinPath(localDir, sanitizeFilename(item.title));
						await ensureFolder(this.app, sub);
						await this.walk(kbId, item.media_id, sub, summary, onProgress, depth + 1);
					} else {
						onProgress?.(item.title);
						await this.syncEntry(item, kbId, localDir, summary);
					}
				}
			}
		} catch (err) {
			summary.failed++;
			summary.notes.push(`目录 ${localDir} 遍历失败：${err instanceof Error ? err.message : String(err)}`);
			showErr(err, `遍历 ${localDir}`);
		}
	}

	private async syncEntry(
		item: KnowledgeListItem,
		kbId: string,
		localDir: string,
		summary: SyncSummary,
	): Promise<void> {
		// 增量策略：知识库条目 API 不返回更新时间，存在即跳过（删除远端不影响本地）
		if (this.settings.downIndex[item.media_id]) {
			summary.skipped++;
			return;
		}
		try {
			const info = await this.client.getMediaInfo(item.media_id);
			const path = await this.writeEntry(item, kbId, info, localDir);
			if (path) {
				this.settings.downIndex[item.media_id] = {
					path,
					kbId,
					kind: "md",
					title: item.title,
					syncedAt: Date.now(),
				};
				summary.created++;
			} else {
				summary.failed++;
			}
		} catch (err) {
			summary.failed++;
			summary.notes.push(`「${item.title}」同步失败：${err instanceof Error ? err.message : String(err)}`);
			showErr(err, `同步「${item.title}」`);
		}
	}

	/** 返回写入的文件路径；null 表示失败 */
	private async writeEntry(
		item: KnowledgeListItem,
		kbId: string,
		info: MediaInfoData,
		localDir: string,
	): Promise<string | null> {
		const baseMeta = {
			ima_media_id: item.media_id,
			ima_kb_id: kbId,
			ima_type: item.media_type,
			tags: item.tags && item.tags.length ? item.tags : undefined,
		};
		const title = sanitizeFilename(item.title.replace(/\.(md|markdown)$/i, ""));

		// 1) 笔记类型：notebook_id → notes 模块读内容
		const notebookId = info.notebook_ext_info?.notebook_id;
		if (notebookId) {
			const content = await this.client.getNoteContent(notebookId);
			const fm = buildFrontmatter({ ...baseMeta, title: item.title, synced: new Date().toISOString() });
			return await this.writeText(joinPath(localDir, `${title}.md`), fm + content.trim() + "\n");
		}

		// 2) 有 url_info：按类型下载
		const urlInfo = info.url_info;
		if (urlInfo?.url) {
			const url = urlInfo.url;
			const headers = urlInfo.headers ?? {};
			// 网页 / 微信文章：url 即原文页面
			if (item.media_type === MediaType.WEB || item.media_type === MediaType.WECHAT) {
				const res = await requestUrlSafe(url, headers);
				const ct = getHeader(res.headers, "content-type");
				let md: string;
				if (ct.includes("text/html") || !ct) {
					md = htmlToMarkdown(res.text);
				} else if (ct.includes("text/plain") || ct.includes("text/markdown")) {
					md = res.text;
				} else {
					return await this.saveBinary(item, kbId, url, headers, localDir, ct);
				}
				const fm = buildFrontmatter({
					...baseMeta,
					title: item.title,
					source: url,
					synced: new Date().toISOString(),
				});
				return await this.writeText(joinPath(localDir, `${title}.md`), fm + md);
			}

			// 文件类：先下载，再按 content-type 分派
			const res = await requestUrlSafe(url, headers);
			const ct = getHeader(res.headers, "content-type").toLowerCase();
			if (
				ct.includes("text/html") ||
				ct.includes("text/markdown") ||
				ct.includes("text/plain") ||
				item.media_type === MediaType.MARKDOWN ||
				item.media_type === MediaType.TXT ||
				item.media_type === MediaType.HTML
			) {
				let md: string;
				if (ct.includes("text/html") || item.media_type === MediaType.HTML) {
					md = htmlToMarkdown(res.text);
				} else {
					md = res.text;
				}
				const fm = buildFrontmatter({ ...baseMeta, title: item.title, synced: new Date().toISOString() });
				return await this.writeText(joinPath(localDir, `${title}.md`), fm + md.trim() + "\n");
			}
			return await this.saveBinary(item, kbId, url, headers, localDir, ct);
		}

		// 3) 无 url_info：写存根
		const fm = buildFrontmatter({
			...baseMeta,
			title: item.title,
			synced: new Date().toISOString(),
		});
		const body = `> [!note] ima 原文暂无法通过 API 获取（${typeLabel(item.media_type)}）\n> 请在 ima 客户端中查看原文。\n`;
		return await this.writeText(joinPath(localDir, `${title}.md`), fm + body);
	}

	/** 二进制附件：保存原文件到附件目录 + 生成存根 md */
	private async saveBinary(
		item: KnowledgeListItem,
		kbId: string,
		url: string,
		headers: Record<string, string>,
		localDir: string,
		contentType: string,
	): Promise<string | null> {
		const res = await requestUrlSafe(url, headers);
		const ext = extFrom(url, contentType, item.title);
		const attDir = this.settings.attachmentFolder || "90-Attachment/ima";
		await ensureFolder(this.app, attDir);
		const fileName = sanitizeFilename(item.title.replace(/\.[a-z0-9]{2,5}$/i, "")) + "." + ext;
		let attPath = joinPath(attDir, fileName);
		attPath = dedupePath(this.app, attPath);
		await this.app.vault.createBinary(attPath, res.arrayBuffer);

		const title = sanitizeFilename(item.title.replace(/\.[a-z0-9]{2,5}$/i, ""));
		const fm = buildFrontmatter({
			ima_media_id: item.media_id,
			ima_kb_id: kbId,
			ima_type: item.media_type,
			title: item.title,
			synced: new Date().toISOString(),
		});
		const body = `> [!info] ima ${typeLabel(item.media_type)} 附件\n> 原文件已保存到本地，也可在 ima 客户端中查看原文。\n\n[[${attPath.replace(/\.md$/, "")}|打开附件]]\n`;
		return await this.writeText(joinPath(localDir, `${title}.md`), fm + body);
	}

	private async writeText(path: string, content: string): Promise<string> {
		const normalized = normalizePath(path);
		const finalPath = dedupePath(this.app, normalized);
		const existing = this.app.vault.getAbstractFileByPath(finalPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(finalPath, content);
		}
		return finalPath;
	}

	/** 个人笔记下行（增量：modify_time 变化才更新） */
	async syncNotes(onProgress?: (msg: string) => void): Promise<SyncSummary> {
		const summary: SyncSummary = { created: 0, skipped: 0, failed: 0, notes: [] };
		if (!this.settings.syncNotes) return summary;
		await ensureFolder(this.app, this.settings.notesFolder);
		let cursor = "";
		try {
			for (let page = 0; page < 5000; page++) {
				const { notes, isEnd } = await this.client.listNote("", cursor, 20);
				for (const note of notes) {
					onProgress?.(note.title);
					const prev = this.settings.noteIndex[note.note_id];
					if (prev && prev.modifyTime >= note.modify_time) {
						summary.skipped++;
						continue;
					}
					try {
						const content = await this.client.getNoteContent(note.note_id);
						const name = sanitizeFilename(note.title || "未命名笔记");
						const fm = buildFrontmatter({
							ima_note_id: note.note_id,
							title: note.title,
							ima_notebook: note.note_ext_info?.folder_name || "",
							updated: new Date(note.modify_time).toISOString(),
							synced: new Date().toISOString(),
						});
						const path = await this.writeText(
							joinPath(this.settings.notesFolder, `${name}.md`),
							fm + content.trim() + "\n",
						);
						this.settings.noteIndex[note.note_id] = {
							path,
							modifyTime: note.modify_time,
						};
						summary.created++;
					} catch (err) {
						summary.failed++;
						summary.notes.push(`笔记「${note.title}」失败：${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (isEnd) break;
				cursor = "";
				// list_note 无 next_cursor，翻到 isEnd 为止；防御死循环由 page 上限保证
			}
		} catch (err) {
			summary.failed++;
			showErr(err, "同步个人笔记");
		}
		return summary;
	}
}

/** requestUrl 的薄封装：带 headers、失败抛错 */
async function requestUrlSafe(
	url: string,
	headers: Record<string, string>,
): Promise<{ text: string; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> {
	const res = await requestUrl({ url, method: "GET", headers, throw: false });
	if (res.status >= 400) {
		throw new Error(`下载失败 HTTP ${res.status}：${url.slice(0, 80)}`);
	}
	return {
		text: res.text,
		arrayBuffer: res.arrayBuffer,
		headers: (res.headers ?? {}) as Record<string, string>,
	};
}

/** 大小写不敏感地取响应头 */
export function getHeader(headers: Record<string, string>, name: string): string {
	const target = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === target) return v ?? "";
	}
	return "";
}
