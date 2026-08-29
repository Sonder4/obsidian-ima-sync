import { App, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import { ImaCgiClient } from "./cgi";
import type ImaSyncPlugin from "./main";

/** 当前活动笔记的 ima 元信息（来自 frontmatter） */
export interface ActiveImaInfo {
	file: TFile;
	mediaId: string;
	kbId: string;
	mediaType?: number;
	tags: string[];
	title?: string;
}

/** 读取当前活动笔记的 ima frontmatter；不满足条件时弹提示并返回 null */
export function getActiveImaInfo(plugin: ImaSyncPlugin, requireCookie = true, silent = false): ActiveImaInfo | null {
	const file = plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== "md") {
		if (!silent) new Notice("请先打开一篇笔记");
		return null;
	}
	const cache = plugin.app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	const mediaId = fm?.ima_media_id;
	const kbId = fm?.ima_kb_id;
	if (!mediaId || !kbId) {
		if (!silent) new Notice("本文不是来自 ima（frontmatter 缺少 ima_media_id / ima_kb_id）");
		return null;
	}
	if (requireCookie && !plugin.settings.webCookie.trim()) {
		if (!silent) new Notice("此功能需要网页会话：请在插件设置中粘贴 ima.qq.com 的 Cookie");
		return null;
	}
	return {
		file,
		mediaId: String(mediaId),
		kbId: String(kbId),
		mediaType: fm?.ima_type !== undefined ? Number(fm.ima_type) : undefined,
		tags: Array.isArray(fm?.tags) ? fm.tags.map(String) : fm?.tags ? [String(fm.tags)] : [],
		title: fm?.title ? String(fm.title) : undefined,
	};
}

export function getCgi(plugin: ImaSyncPlugin): ImaCgiClient {
	return new ImaCgiClient(plugin.settings.webCookie);
}

/**
 * 把活动笔记解析为内部命名空间对象：{ kbId(=UID), mediaId(内部), folderId }。
 * 内部 media_id 与官方 OpenAPI 的不同，需按标题搜索解析。
 */
export async function resolveInternal(
	plugin: ImaSyncPlugin,
	cgi: ImaCgiClient,
	info: ActiveImaInfo,
): Promise<{ kbId: string; mediaId: string; folderId?: string; mediaType?: number } | null> {
	const kbId = cgi.personalKbId;
	const base = info.file.basename;
	for (const q of [base, `${base}.md`, info.title ?? ""]) {
		if (!q) continue;
		const hits = await cgi.searchKnowledge(kbId, q);
		const hit = hits.find((h) => h.title === base || h.title === `${base}.md` || h.title === info.title);
		if (hit) {
			return { kbId, mediaId: hit.media_id, folderId: hit.parent_folder_id, mediaType: hit.media_type };
		}
	}
	new Notice(
		`ima 内部命名空间中未找到「${base}」：官方接口上传的内容对内部接口不可见。\n请对该笔记使用一次「上行同步（内部通道）」后重试。`,
		9000,
	);
	return null;
}

/** 知识库选择器（在线列表，失败回退设置缓存） */
class KbPickerModal extends FuzzySuggestModal<{ id: string; name: string }> {
	constructor(
		app: App,
		private items: { id: string; name: string }[],
		private onPick: (kb: { id: string; name: string }) => void,
	) {
		super(app);
		this.setPlaceholder("选择目标知识库…");
	}

	getItems(): { id: string; name: string }[] {
		return this.items;
	}

	getItemText(item: { id: string; name: string }): string {
		return item.name;
	}

	onChooseItem(item: { id: string; name: string }): void {
		this.onPick(item);
	}
}

/** 拉取知识库列表（OpenAPI 官方接口，无需 Cookie） */
export async function fetchKbList(plugin: ImaSyncPlugin): Promise<{ id: string; name: string }[]> {
	try {
		const list = await plugin.getClient().getAddableKbList();
		plugin.settings.kbListCache = list;
		await plugin.saveSettings();
		return list;
	} catch {
		return plugin.settings.kbListCache;
	}
}

function pickKb(plugin: ImaSyncPlugin, onPick: (kb: { id: string; name: string }) => void): void {
	void fetchKbList(plugin).then((list) => {
		if (!list.length) {
			new Notice("未获取到知识库列表，请先在设置中配置凭证并验证");
			return;
		}
		new KbPickerModal(plugin.app, list, onPick).open();
	});
}

/** 单行文本输入模态框 */
class TextInputModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private initial: string,
		private onSubmit: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		const input = this.contentEl.createEl("input", { type: "text" });
		input.style.width = "100%";
		input.value = this.initial;
		input.placeholder = this.placeholder;
		const row = this.contentEl.createDiv();
		row.style.display = "flex";
		row.style.gap = "8px";
		row.style.justifyContent = "flex-end";
		row.style.marginTop = "12px";
		const ok = row.createEl("button", { text: "确定" });
		ok.addClass("mod-cta");
		ok.onclick = () => {
			const v = input.value.trim();
			if (!v) return;
			this.close();
			this.onSubmit(v);
		};
		row.createEl("button", { text: "取消" }).onclick = () => this.close();
		input.onkeydown = (e) => {
			if (e.key === "Enter") ok.click();
		};
		input.focus();
		input.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 标签编辑模态框：展示知识库已有标签 + 编辑当前条目标签 */
class TagEditModal extends Modal {
	constructor(
		private plugin: ImaSyncPlugin,
		private info: ActiveImaInfo,
		private cgi: ImaCgiClient,
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "编辑 ima 标签" });
		const target = await resolveInternal(this.plugin, this.cgi, this.info);
		if (!target) {
			this.close();
			return;
		}
		const input = contentEl.createEl("input", { type: "text" });
		input.style.width = "100%";
		input.value = this.info.tags.join("，");
		input.placeholder = "多个标签用逗号分隔";

		const sugTitle = contentEl.createEl("div", { text: "知识库已有标签（点击添加）：" });
		sugTitle.style.marginTop = "12px";
		sugTitle.style.color = "var(--text-muted)";
		sugTitle.style.fontSize = "0.85em";
		const sugBox = contentEl.createDiv();
		sugBox.style.display = "flex";
		sugBox.style.flexWrap = "wrap";
		sugBox.style.gap = "6px";

		const row = contentEl.createDiv();
		row.style.display = "flex";
		row.style.gap = "8px";
		row.style.justifyContent = "flex-end";
		row.style.marginTop = "16px";

		const save = async () => {
			const tags = input.value
				.split(/[,，;；\s]+/)
				.map((t) => t.trim())
				.filter(Boolean);
			try {
				await this.cgi.updateTags(target.kbId, target.mediaId, tags, target.folderId, target.mediaType);
				// 同步 frontmatter
				await this.plugin.app.fileManager.processFrontMatter(this.info.file, (fm) => {
					fm.tags = tags;
				});
				new Notice(`标签已更新：${tags.join("、") || "（无）"}`);
				this.close();
			} catch (err) {
				new Notice(`更新失败：${err instanceof Error ? err.message : String(err)}`, 8000);
			}
		};

			row.createEl("button", { text: "取消" }).onclick = () => this.close();
		const ok = row.createEl("button", { text: "保存", cls: "mod-cta" });
		ok.onclick = () => void save();

		// 加载知识库标签建议
		try {
			const kbTags = await this.cgi.getTags(target.kbId);
			for (const t of kbTags) {
				if (!t.tag) continue;
				const chip = sugBox.createEl("button", { text: t.tag });
				chip.addClass("mod-muted");
				chip.style.fontSize = "0.85em";
				chip.onclick = () => {
					const cur = input.value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
					if (!cur.includes(t.tag)) input.value = [...cur, t.tag].join("，");
				};
			}
			if (!kbTags.length) sugTitle.setText("知识库暂无已有标签");
		} catch {
			sugTitle.setText("（知识库标签列表获取失败，可直接输入）");
		}
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 知识库标签管理模态框（重命名/删除） */
class KbTagManageModal extends Modal {
	constructor(
		private plugin: ImaSyncPlugin,
		private kbId: string,
		private cgi: ImaCgiClient,
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "知识库标签管理" });
		const listBox = contentEl.createDiv();
		listBox.createEl("p", { text: "加载中…" });
		try {
			const tags = await this.cgi.getTags(this.kbId);
			contentEl.empty();
			contentEl.createEl("h3", { text: "知识库标签管理" });
			if (!tags.length) {
				contentEl.createEl("p", { text: "知识库暂无标签", cls: "mod-muted" });
			}
			for (const t of tags) {
				const row = contentEl.createDiv();
				row.style.display = "flex";
				row.style.alignItems = "center";
				row.style.gap = "8px";
				row.style.padding = "4px 0";
				row.createEl("span", { text: t.tag }).style.flex = "1";
				const renameBtn = row.createEl("button", { text: "重命名" });
				renameBtn.onclick = () => {
					this.close();
					new TextInputModal(this.plugin.app, `重命名标签「${t.tag}」`, "新标签名", t.tag, async (newTag) => {
						try {
							await this.cgi.renameTag(this.kbId, t.tag, newTag);
							new Notice(`已重命名：${t.tag} → ${newTag}`);
						} catch (err) {
							new Notice(`失败：${err instanceof Error ? err.message : String(err)}`, 8000);
						}
					}).open();
				};
				const delBtn = row.createEl("button", { text: "删除", cls: "mod-warning" });
				delBtn.onclick = () => {
					this.close();
					new TextInputModal(this.plugin.app, `确认删除标签「${t.tag}」？`, "输入标签名以确认", "", async (confirm) => {
						if (confirm !== t.tag) {
							new Notice("输入不一致，已取消");
							return;
						}
						try {
							await this.cgi.delTags(this.kbId, [t.tag]);
							new Notice(`已删除标签：${t.tag}`);
						} catch (err) {
							new Notice(`失败：${err instanceof Error ? err.message : String(err)}`, 8000);
						}
					}).open();
				};
			}
			const closeRow = contentEl.createDiv();
			closeRow.style.marginTop = "12px";
			closeRow.style.textAlign = "right";
			closeRow.createEl("button", { text: "关闭" }).onclick = () => this.close();
		} catch (err) {
			contentEl.empty();
			contentEl.createEl("p", { text: `加载失败：${err instanceof Error ? err.message : String(err)}` });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 注册全部「原生接口」管理命令 */
export function registerImaManageCommands(plugin: ImaSyncPlugin): void {
	const requireCookie = (): ImaCgiClient | null => {
		if (!plugin.settings.webCookie.trim()) {
			new Notice("此功能需要网页会话：请在插件设置中粘贴 ima.qq.com 的 Cookie");
			return null;
		}
		return getCgi(plugin);
	};

	// 1. 编辑当前笔记标签
	plugin.addCommand({
		id: "ima-edit-tags",
		name: "编辑本文 ima 标签",
		checkCallback: (checking: boolean) => {
			const info = getActiveImaInfo(plugin, true, checking);
			if (!checking && info) {
				new TagEditModal(plugin, info, getCgi(plugin)).open();
			}
			return !!info;
		},
	});

	// 2. 重命名 ima 标题
	plugin.addCommand({
		id: "ima-rename",
		name: "重命名本文在 ima 中的标题",
		checkCallback: (checking: boolean) => {
			const info = getActiveImaInfo(plugin, true, checking);
			if (!checking && info) {
				void (async () => {
					const cgi = getCgi(plugin);
					const target = await resolveInternal(plugin, cgi, info);
					if (!target) return;
					new TextInputModal(
						plugin.app,
						"重命名 ima 标题",
						"新标题",
						info.title || info.file.basename,
						async (title) => {
							try {
								await cgi.renameKnowledge({
									kbId: target.kbId,
									mediaId: target.mediaId,
									title,
									folderId: target.folderId,
									mediaType: target.mediaType,
								});
								await plugin.app.fileManager.processFrontMatter(info.file, (fm) => {
									fm.title = title;
								});
								new Notice(`已重命名为「${title}」`);
							} catch (err) {
								new Notice(`失败：${err instanceof Error ? err.message : String(err)}`, 8000);
							}
						},
					).open();
				})();
			}
			return !!info;
		},
	});

	// 3. 跨库复制
	plugin.addCommand({
		id: "ima-copy-to-kb",
		name: "复制本文到其他知识库",
		checkCallback: (checking: boolean) => {
			const info = getActiveImaInfo(plugin, true, checking);
			if (!checking && info) {
				void (async () => {
					const cgi = getCgi(plugin);
					const target = await resolveInternal(plugin, cgi, info);
					if (!target) return;
					pickKb(plugin, async (kb) => {
						if (kb.id === info.kbId) {
							new Notice("本文已在该知识库中");
							return;
						}
						try {
							const r = await cgi.copyKnowledge({ mediaIds: [target.mediaId], dstKbId: kb.id });
							new Notice(`已发起复制到「${kb.name}」${r.mediaIds?.length ? `（新 media_id: ${r.mediaIds[0].slice(-16)}）` : ""}`, 6000);
						} catch (err) {
							new Notice(`复制失败：${err instanceof Error ? err.message : String(err)}`, 8000);
						}
					});
				})();
			}
			return !!info;
		},
	});

	// 4. 用本文内容替换 ima 原文（内部通道：上传新版本 → replace；replace 不可用时回退删除+重建）
	plugin.addCommand({
		id: "ima-replace-content",
		name: "用本文内容替换 ima 原文",
		checkCallback: (checking: boolean) => {
			const info = getActiveImaInfo(plugin, true, checking);
			if (!checking && info) {
				void (async () => {
					const cgi = getCgi(plugin);
					const target = await resolveInternal(plugin, cgi, info);
					if (!target) return;
					try {
						// 去掉 frontmatter 后经内部通道上传新版本
						const raw = await plugin.app.vault.read(info.file);
						const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim() || raw;
						const bytes = new TextEncoder().encode(content);
						const fileName = `${info.file.basename}.md`;
						const { mediaId: newMediaId } = await cgi.uploadMarkdown(target.kbId, fileName, bytes, target.folderId);
						// 删除旧版本（replace_knowledge 服务端暂不可用，采用删旧+新版）
						if (target.mediaId !== newMediaId) {
							try {
								await cgi.delKnowledge(target.kbId, [target.mediaId]);
							} catch {
								// 旧版删除失败不阻断（保留旧版，仅提示）
								new Notice("旧版本删除失败，知识库中同时存在新旧两个版本", 8000);
							}
						}
						await plugin.app.fileManager.processFrontMatter(info.file, (fm) => {
							fm.ima_media_id = newMediaId;
							fm.synced = new Date().toISOString();
						});
						new Notice("已用本文内容替换 ima 原文（删除旧版 + 新版）");
					} catch (err) {
						new Notice(`替换失败：${err instanceof Error ? err.message : String(err)}`, 8000);
					}
				})();
			}
			return !!info;
		},
	});

	// 5. 新建 ima 文件夹
	plugin.addCommand({
		id: "ima-create-folder",
		name: "在 ima 知识库中新建文件夹",
		callback: () => {
			const cgi = requireCookie();
			if (!cgi) return;
			new TextInputModal(plugin.app, "新建文件夹（个人知识库根目录）", "文件夹名称", "", async (title) => {
				try {
					await cgi.createFolder(cgi.personalKbId, cgi.personalKbId, title);
					new Notice(`已创建文件夹「${title}」`);
				} catch (err) {
					new Notice(`失败：${err instanceof Error ? err.message : String(err)}`, 8000);
				}
			}).open();
		},
	});

	// 6. 知识库标签管理（重命名/删除标签）
	plugin.addCommand({
		id: "ima-tag-manage",
		name: "管理 ima 知识库标签",
		callback: () => {
			const cgi = requireCookie();
			if (!cgi) return;
			// 优先用当前笔记所在知识库
			const info = getActiveImaInfo(plugin, false, true);
			new KbTagManageModal(plugin, cgi.personalKbId, cgi).open();
			void info;
		},
	});

	// 7. 新建知识库
	plugin.addCommand({
		id: "ima-create-kb",
		name: "新建 ima 知识库",
		callback: () => {
			const cgi = requireCookie();
			if (!cgi) return;
			new TextInputModal(plugin.app, "新建知识库", "知识库名称", "", async (name) => {
				try {
					const r = await cgi.createKnowledgeBase(name);
					new Notice(`已创建知识库「${name}」${r.id ? "" : "（请在 ima 客户端确认）"}`);
					await fetchKbList(plugin);
				} catch (err) {
					new Notice(`失败：${err instanceof Error ? err.message : String(err)}`, 8000);
				}
			}).open();
		},
	});
}
