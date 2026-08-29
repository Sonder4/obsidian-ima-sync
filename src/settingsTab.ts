import { AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type ImaSyncPlugin from "./main";

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private onPick: (path: string) => void,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		const out: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					if (child.path.toLowerCase().includes(q)) out.push(child);
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return out;
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.onPick(folder.path);
		this.close();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private desc: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		this.contentEl.createEl("p", { text: this.desc });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("确认")
					.setWarning()
					.onClick(() => {
						this.onConfirm();
						this.close();
					}),
			)
			.addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ImaSettingTab extends PluginSettingTab {
	private plugin: ImaSyncPlugin;

	constructor(app: App, plugin: ImaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// ============ 连接 ============
		containerEl.createEl("h3", { text: "连接 ima" });
		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("从 ima 桌面端「设置 → 开发者选项」或 ima.qq.com/agent-interface 获取")
			.addText((text) =>
				text.setValue(s.clientId).onChange(async (v) => {
					s.clientId = v.trim();
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("API Key")
			.setDesc("仅在本地保存（data.json 已被 .gitignore 忽略），只发送到 ima.qq.com")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(s.apiKey).onChange(async (v) => {
					s.apiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("验证并刷新知识库列表")
			.setDesc("调用 ima 接口验证凭证，并拉取你可操作的知识库")
			.addButton((btn) =>
				btn.setButtonText("验证").onClick(async () => {
					btn.setDisabled(true).setButtonText("验证中…");
					try {
						const list = await this.plugin.getClient().getAddableKbList();
						s.kbListCache = list;
						await this.plugin.saveSettings();
						new Notice(`凭证有效，共 ${list.length} 个知识库`);
						this.display();
					} catch (err) {
						new Notice(`验证失败：${err instanceof Error ? err.message : String(err)}`, 8000);
						btn.setDisabled(false).setButtonText("验证");
					}
				}),
			);

		// ============ 下行 ============
		containerEl.createEl("h3", { text: "下行同步（ima 知识库 → Obsidian）" });
		if (!s.kbListCache.length) {
			containerEl.createEl("p", {
				text: "尚未获取知识库列表：请先在上方「验证并刷新知识库列表」。",
				cls: "mod-muted",
			});
		}
		for (const kb of s.kbListCache) {
			const selected = s.selectedKbIds.includes(kb.id);
			const setting = new Setting(containerEl)
				.setName(kb.name)
				.setClass("ima-kb-setting");
			setting.addToggle((toggle) =>
				toggle.setValue(selected).onChange(async (v) => {
					if (v) {
						if (!s.selectedKbIds.includes(kb.id)) s.selectedKbIds.push(kb.id);
						if (!s.kbFolders[kb.id]) s.kbFolders[kb.id] = `20-ima/${kb.name}`;
					} else {
						s.selectedKbIds = s.selectedKbIds.filter((id) => id !== kb.id);
					}
					await this.plugin.saveSettings();
					this.display();
				}),
			);
			if (selected) {
				setting.addText((text) =>
					text
						.setPlaceholder("20-ima/" + kb.name)
						.setValue(s.kbFolders[kb.id] ?? `20-ima/${kb.name}`)
						.onChange(async (v) => {
							s.kbFolders[kb.id] = v.trim() || `20-ima/${kb.name}`;
							await this.plugin.saveSettings();
						}),
				);
			}
		}
		if (s.kbListCache.length) {
			containerEl.createEl("p", {
				text: "提示：同步为增量拉取（已同步的条目跳过，云端删除不影响本地文件）。文件夹路径留空则使用默认 20-ima/知识库名。",
				cls: "mod-muted",
			});
		}

		new Setting(containerEl)
			.setName("同时同步 ima 个人笔记")
			.setDesc("将 ima 个人笔记（非知识库内容）只读同步到下方目录")
			.addToggle((toggle) =>
				toggle.setValue(s.syncNotes).onChange(async (v) => {
					s.syncNotes = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		if (s.syncNotes) {
			new Setting(containerEl)
				.setName("个人笔记目录")
				.addText((text) =>
					text.setValue(s.notesFolder).onChange(async (v) => {
						s.notesFolder = v.trim() || "20-ima/个人笔记";
						await this.plugin.saveSettings();
					}),
				);
		}

		// ============ 上行 ============
		containerEl.createEl("h3", { text: "上行同步（Obsidian → ima 知识库）" });
		containerEl.createEl("p", {
			text: "把 vault 中指定文件夹的 Markdown 笔记自动上传到 ima 知识库。注意：官方 API 只支持新增，不支持覆盖/删除已上传内容。",
			cls: "mod-muted",
		});
		s.upMappings.forEach((mapping, idx) => {
			const setting = new Setting(containerEl).setName(`映射 ${idx + 1}`);
			setting.addText((text) => {
				text.setPlaceholder("vault 文件夹，如 10-Literature").setValue(mapping.folder);
				new FolderSuggest(this.plugin.app, text.inputEl, (path) => {
					mapping.folder = path;
					this.plugin.saveSettings();
				});
				text.onChange(async (v) => {
					mapping.folder = v.trim();
					await this.plugin.saveSettings();
				});
			});
			setting.addDropdown((drop) => {
				drop.addOption("", "选择知识库");
				for (const kb of s.kbListCache) drop.addOption(kb.id, kb.name);
				if (!s.kbListCache.length && mapping.kbId) drop.addOption(mapping.kbId, mapping.kbId);
				drop.setValue(mapping.kbId).onChange(async (v) => {
					mapping.kbId = v;
					await this.plugin.saveSettings();
				});
			});
			setting.addButton((btn) =>
				btn.setIcon("trash").setTooltip("删除此映射").onClick(async () => {
					s.upMappings.splice(idx, 1);
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		});
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("添加上行映射").onClick(async () => {
				s.upMappings.push({ folder: "", kbId: "" });
				await this.plugin.saveSettings();
				this.display();
			}),
		);
		new Setting(containerEl)
			.setName("跳过来自 ima 的文件")
			.setDesc("frontmatter 含 ima_media_id / ima_note_id 的文件视为下行内容，不回传（防止同步回环）")
			.addToggle((toggle) =>
				toggle.setValue(s.skipImaFiles).onChange(async (v) => {
					s.skipImaFiles = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("已上传文件的修改重新上传为新副本")
			.setDesc("关闭时，已上传文件再被修改只会提示、不上传（避免知识库中出现重复副本）")
			.addToggle((toggle) =>
				toggle.setValue(s.reuploadChanged).onChange(async (v) => {
					s.reuploadChanged = v;
					await this.plugin.saveSettings();
				}),
			);

		// ============ 自动同步 ============
		containerEl.createEl("h3", { text: "自动同步" });
		new Setting(containerEl)
			.setName("定时自动同步")
			.setDesc("按下方间隔自动执行「下行 + 上行」")
			.addToggle((toggle) =>
				toggle.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await this.plugin.saveSettings();
					this.plugin.armAutoSync();
				}),
			);
		new Setting(containerEl)
			.setName("同步间隔（分钟）")
			.setDesc("最低 5 分钟")
			.addText((text) =>
				text.setValue(String(s.intervalMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 5) {
						s.intervalMinutes = n;
						await this.plugin.saveSettings();
						this.plugin.armAutoSync();
					}
				}),
			);

		// ============ 高级 ============
		containerEl.createEl("h3", { text: "高级" });
		new Setting(containerEl)
			.setName("附件保存目录")
			.setDesc("下行时二进制附件（PDF/Word/PPT 等）的存放位置")
			.addText((text) =>
				text.setValue(s.attachmentFolder).onChange(async (v) => {
					s.attachmentFolder = v.trim() || "90-Attachment/ima";
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("清空同步索引")
			.setDesc("下次同步将重新拉取全部条目（本地已改动的文件不会覆盖，会另存序号副本）；不会删除任何笔记")
			.addButton((btn) =>
				btn.setButtonText("清空…").onClick(() => {
					new ConfirmModal(
						this.app,
						"清空同步索引？",
						"将忘记已同步记录，下次同步会重新创建文件（重名文件会另存副本），不会删除现有笔记。",
						async () => {
							s.downIndex = {};
							s.upIndex = {};
							s.noteIndex = {};
							await this.plugin.saveSettings();
							new Notice("同步索引已清空");
						},
					).open();
				}),
			);
	}
}
