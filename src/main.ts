import { Notice, Plugin } from "obsidian";
import { ImaClient } from "./api";
import { DownSync, type SyncSummary } from "./down";
import { UpSync } from "./up";
import { DEFAULT_SETTINGS, type ImaSyncSettings } from "./settings";
import { ImaSettingTab } from "./settingsTab";

export default class ImaSyncPlugin extends Plugin {
	settings: ImaSyncSettings = DEFAULT_SETTINGS;
	private client: ImaClient | null = null;
	private down: DownSync | null = null;
	private up: UpSync | null = null;
	private autoTimer: number | null = null;
	private syncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.rebuildClients();

		this.addSettingTab(new ImaSettingTab(this.app, this));

		this.addRibbonIcon("refresh-cw", "IMA Sync：立即同步（下行 + 上行）", () => {
			this.runSync("all");
		});

		this.addCommand({
			id: "ima-sync-all",
			name: "立即同步（下行 + 上行）",
			callback: () => this.runSync("all"),
		});
		this.addCommand({
			id: "ima-sync-down",
			name: "立即下行同步（ima → vault）",
			callback: () => this.runSync("down"),
		});
		this.addCommand({
			id: "ima-sync-up",
			name: "立即上行同步（vault → ima）",
			callback: () => this.runSync("up"),
		});

		this.armAutoSync();
	}

	onunload(): void {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
		this.autoTimer = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ImaSyncSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getClient(): ImaClient {
		this.rebuildClients();
		if (!this.client || !this.client.configured) {
			throw new Error("请先在设置中配置 Client ID 与 API Key");
		}
		return this.client;
	}

	/** 凭证可能被设置页修改过，重建依赖对象 */
	private rebuildClients(): void {
		this.client = new ImaClient(this.settings.clientId, this.settings.apiKey);
		this.down = new DownSync(this.app, this.client, this.settings);
		this.up = new UpSync(this.app, this.client, this.settings);
	}

	/** 重新装载自动同步定时器（设置变更后调用） */
	armAutoSync(): void {
		if (this.autoTimer !== null) {
			window.clearInterval(this.autoTimer);
			this.autoTimer = null;
		}
		if (this.settings.autoSync && this.settings.intervalMinutes >= 5) {
			this.autoTimer = window.setInterval(
				() => this.runSync("all", true),
				this.settings.intervalMinutes * 60 * 1000,
			);
		}
	}

	/** 汇总两条 Notice 展示结果 */
	private report(mode: string, results: { label: string; summary: SyncSummary }[]): void {
		const totalCreated = results.reduce((a, r) => a + r.summary.created, 0);
		const totalSkipped = results.reduce((a, r) => a + r.summary.skipped, 0);
		const totalFailed = results.reduce((a, r) => a + r.summary.failed, 0);
		let msg = `IMA Sync ${mode} 完成：新增 ${totalCreated}，跳过 ${totalSkipped}`;
		if (totalFailed) msg += `，失败 ${totalFailed}`;
		const notice = new Notice(msg, totalFailed ? 12000 : 5000);
		const details = results.flatMap((r) => r.summary.notes);
		if (details.length) {
			setTimeout(() => {
				new Notice(`IMA Sync 详情：\n${details.slice(0, 12).join("\n")}${details.length > 12 ? "\n…" : ""}`, 12000);
			}, 300);
			console.info("[IMA Sync] 详情：", details);
		}
		void notice;
	}

	async runSync(mode: "all" | "down" | "up" = "all", silentStart = false): Promise<void> {
		if (this.syncing) {
			if (!silentStart) new Notice("IMA Sync 正在同步中，请稍候");
			return;
		}
		try {
			this.rebuildClients();
			if (!this.client?.configured) {
				new Notice("IMA Sync：请先在设置中配置 Client ID 与 API Key", 8000);
				return;
			}
		} catch (err) {
			new Notice(`IMA Sync：${err instanceof Error ? err.message : String(err)}`, 8000);
			return;
		}

		this.syncing = true;
		const progress = new Notice("IMA Sync 同步中…", 0);
		const onProgress = (msg: string) => progress.setMessage(`IMA Sync 同步中：${msg}`);
		try {
			const results: { label: string; summary: SyncSummary }[] = [];
			if (mode === "all" || mode === "down") {
				if (!this.settings.selectedKbIds.length && !this.settings.syncNotes) {
					new Notice("IMA Sync：尚未选择要同步的知识库，请到设置中勾选", 8000);
				} else {
					results.push({ label: "下行", summary: (await this.down!.syncKbs(onProgress)) as SyncSummary });
					if (this.settings.syncNotes) {
						results.push({ label: "个人笔记", summary: await this.down!.syncNotes(onProgress) });
					}
				}
			}
			if (mode === "all" || mode === "up") {
				if (this.settings.upMappings.length) {
					results.push({ label: "上行", summary: await this.up!.syncAll(onProgress) });
				}
			}
			await this.saveSettings();
			const label = mode === "all" ? "" : mode === "down" ? "（仅下行）" : "（仅上行）";
			if (results.length) this.report(label, results);
			else if (!silentStart) new Notice("IMA Sync：没有可执行的任务（未选知识库 / 未配置上行映射）", 8000);
		} catch (err) {
			console.error("[IMA Sync] 同步失败：", err);
			new Notice(`IMA Sync 同步失败：${err instanceof Error ? err.message : String(err)}`, 12000);
		} finally {
			progress.hide();
			this.syncing = false;
		}
	}
}
