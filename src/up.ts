import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { ImaClient } from "./api";
import { ImaCgiClient } from "./cgi";
import { uploadToCos, contentHash } from "./cos";
import { frontmatterHasKey } from "./convert";
import { MediaType } from "./types";
import { sanitizeFilename, showErr } from "./util";
import type { ImaSyncSettings, UpMapping } from "./settings";
import type { SyncSummary } from "./down";

export class UpSync {
	private cgi: ImaCgiClient | null = null;

	constructor(
		private app: App,
		private client: ImaClient,
		private settings: ImaSyncSettings,
	) {}

	/** 用户提供了网页会话 Cookie 时启用「真更新」（删除旧版 + 重传） */
	private getCgi(): ImaCgiClient | null {
		if (!this.settings.webCookie.trim()) return null;
		if (!this.cgi) this.cgi = new ImaCgiClient(this.settings.webCookie);
		return this.cgi;
	}

	async syncAll(onProgress?: (msg: string) => void): Promise<SyncSummary> {
		const summary: SyncSummary = { created: 0, skipped: 0, failed: 0, notes: [] };
		for (const mapping of this.settings.upMappings) {
			const folder = this.app.vault.getAbstractFileByPath(normalizePath(mapping.folder));
			if (!(folder instanceof TFolder)) {
				summary.notes.push(`上行目录不存在，已跳过：${mapping.folder}`);
				continue;
			}
			onProgress?.(mapping.folder);
			const files: TFile[] = [];
			this.collectMd(folder, files);
			if (!files.length) continue;

			// 过滤回环：来自 ima 的文件默认不上传
			const candidates: TFile[] = [];
			for (const file of files) {
				const content = await this.app.vault.read(file);
				if (this.settings.skipImaFiles && frontmatterHasKey(content, ["ima_media_id", "ima_note_id"])) {
					summary.skipped++;
					continue;
				}
				candidates.push(file);
			}
			if (!candidates.length) continue;

			// 分拣：新增 / 未变化 / 有修改
			const fresh: TFile[] = [];
			const changed: { file: TFile; hash: string }[] = [];
			const cgi = this.getCgi();
			for (const file of candidates) {
				const content = await this.app.vault.read(file);
				const hash = contentHash(content);
				const prev = this.settings.upIndex[file.path];
				if (prev && prev.hash === hash && prev.kbId === mapping.kbId) {
					summary.skipped++;
					continue;
				}
				if (prev) {
					if (this.settings.reuploadChanged) {
						changed.push({ file, hash });
					} else {
						summary.skipped++;
						const hint = cgi ? "可在设置开启「重新上传」" : "官方 API 不支持覆盖更新，未回传";
						if (!summary.notes.some((n) => n.startsWith("以下已上传文件有本地修改")))
							summary.notes.push(`以下已上传文件有本地修改（${hint}）：`);
						summary.notes.push(`　· ${file.path}`);
					}
					continue;
				}
				fresh.push(file);
			}

			// 重名检查（一次批量调用）
			const freshAfterCheck: TFile[] = [];
			if (fresh.length) {
				try {
					const results = await this.client.checkRepeatedNames(
						mapping.kbId,
						fresh.map((f) => ({ name: `${sanitizeFilename(f.basename)}.md`, media_type: MediaType.MARKDOWN })),
					);
					const repeated = new Set(results.filter((r) => r.is_repeated).map((r) => r.name));
					for (const file of fresh) {
						const name = `${sanitizeFilename(file.basename)}.md`;
						if (repeated.has(name)) {
							summary.skipped++;
							summary.notes.push(`知识库中已存在同名文件，未上传：${name}（${file.path}）`);
						} else {
							freshAfterCheck.push(file);
						}
					}
				} catch (err) {
					// 重名检查失败不阻断上传
					summary.notes.push(`重名检查失败（继续上传）：${err instanceof Error ? err.message : String(err)}`);
					freshAfterCheck.push(...fresh);
				}
			}

			for (const file of freshAfterCheck) {
				onProgress?.(file.path);
				// Cookie 模式优先走内部命名空间上传（此后文档可改名/删除/打标签）
				const cgi = this.getCgi();
				if (cgi && cgi.configured) {
					try {
						const content = await this.app.vault.read(file);
						if (this.settings.skipImaFiles && frontmatterHasKey(content, ["ima_media_id"])) {
							summary.skipped++;
							continue;
						}
						const bytes = new TextEncoder().encode(content);
						const fileName = `${sanitizeFilename(file.basename)}.md`;
						const { mediaId } = await cgi.uploadMarkdown(cgi.personalKbId, fileName, bytes);
						this.settings.upIndex[file.path] = {
							mediaId,
							kbId: cgi.personalKbId,
							hash: contentHash(content),
						};
						summary.created++;
						continue;
					} catch (err) {
						summary.notes.push(`内部通道上传「${file.path}」失败，回退官方接口：${err instanceof Error ? err.message : String(err)}`);
					}
				}
				await this.upload(file, mapping, undefined, summary);
			}
			for (const { file, hash } of changed) {
				onProgress?.(file.path);
				const prev = this.settings.upIndex[file.path];
				const cgi = this.getCgi();
				if (cgi && prev?.mediaId && prev.kbId === cgi.personalKbId) {
					// 真更新：删除插件自己上传的旧版，再以原文件名经内部通道重传
					try {
						await cgi.delKnowledge(prev.kbId, [prev.mediaId]);
						delete this.settings.upIndex[file.path];
						const content = await this.app.vault.read(file);
						const bytes = new TextEncoder().encode(content);
						const fileName = `${sanitizeFilename(file.basename)}.md`;
						const { mediaId } = await cgi.uploadMarkdown(prev.kbId, fileName, bytes);
						this.settings.upIndex[file.path] = { mediaId, kbId: prev.kbId, hash: hash ?? contentHash(content) };
						summary.created++;
						continue;
					} catch (err) {
						summary.notes.push(
							`「${file.basename}」真更新失败（${err instanceof Error ? err.message : String(err)}），回退为副本上传`,
						);
					}
				}
				if (cgi && prev?.mediaId && prev.kbId !== cgi.personalKbId) {
					// 官方通道上传的旧文档：内部接口不可见，仅副本模式
				}
				const stamp = window.moment(file.stat.mtime).format("YYYY-MM-DD HHmm");
				const copyBase = `${sanitizeFilename(file.basename)}（更新 ${stamp}）`;
				await this.upload(file, mapping, copyBase, summary, hash);
			}
		}
		return summary;
	}

	private collectMd(folder: TFolder, out: TFile[]): void {
		for (const child of folder.children) {
			if (child instanceof TFolder) this.collectMd(child, out);
			else if (child instanceof TFile && child.extension === "md") out.push(child);
		}
	}

	private async upload(
		file: TFile,
		mapping: UpMapping,
		copyBase: string | undefined,
		summary: SyncSummary,
		hashOverride?: string,
	): Promise<void> {
		try {
			const content = await this.app.vault.read(file);
			const bytes = new TextEncoder().encode(content);
			const base = copyBase ?? sanitizeFilename(file.basename);
			const fileName = `${base}.md`;
			// 官方规则：文件上传时 title 必须与 file_name（含扩展名）一致
			const cm = await this.client.createMedia({
				file_name: fileName,
				file_size: bytes.byteLength,
				content_type: "text/markdown",
				knowledge_base_id: mapping.kbId,
				file_ext: "md",
			});
			await uploadToCos(bytes, cm.cos_credential, "text/markdown");
			await this.client.addKnowledge({
				media_type: MediaType.MARKDOWN,
				media_id: cm.media_id,
				title: fileName,
				knowledge_base_id: mapping.kbId,
				file_info: {
					cos_key: cm.cos_credential.cos_key,
					file_size: bytes.byteLength,
					last_modify_time: Math.floor(file.stat.mtime / 1000),
					file_name: fileName,
				},
			});
			this.settings.upIndex[file.path] = {
				mediaId: cm.media_id,
				kbId: mapping.kbId,
				hash: hashOverride ?? contentHash(content),
				uploadedAs: copyBase ? fileName : undefined,
			};
			summary.created++;
		} catch (err) {
			summary.failed++;
			summary.notes.push(`上传「${file.path}」失败：${err instanceof Error ? err.message : String(err)}`);
			showErr(err, `上传「${file.basename}」`);
		}
	}
}
