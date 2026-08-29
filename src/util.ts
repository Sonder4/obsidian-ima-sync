import { Notice, normalizePath, type App } from "obsidian";

/** 清理不适合作为文件名的字符 */
export function sanitizeFilename(name: string): string {
	let out = (name || "untitled")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// 控制尾部点与空格（Windows 限制）
	out = out.replace(/[. ]+$/, "");
	if (!out) out = "untitled";
	if (out.length > 120) out = out.slice(0, 120).trim();
	return out;
}

/** 拼接 vault 相对路径 */
export function joinPath(base: string, name: string): string {
	return normalizePath(`${base}/${name}`);
}

/** 递归创建 vault 文件夹 */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const path = normalizePath(folderPath);
	if (!path || path === "/") return;
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing) return;
	// Obsidian 的 createFolder 会自动创建父级，但逐级创建更稳妥
	const parts = path.split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				// 并发创建等场景忽略
			}
		}
	}
}

/** 找一个不冲突的文件路径（冲突时追加序号） */
export function dedupePath(app: App, path: string): string {
	if (!app.vault.getAbstractFileByPath(path)) return path;
	const dot = path.lastIndexOf(".");
	const base = dot > 0 ? path.slice(0, dot) : path;
	const ext = dot > 0 ? path.slice(dot) : "";
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base} ${i}${ext}`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
	return `${base} ${Date.now()}${ext}`;
}

/** 从 URL 或 content-type 推断扩展名 */
export function extFrom(url: string, contentType: string, fallbackTitle: string): string {
	const ctMap: Record<string, string> = {
		"application/pdf": "pdf",
		"application/msword": "doc",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"application/vnd.ms-powerpoint": "ppt",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"application/vnd.ms-excel": "xls",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"application/epub+zip": "epub",
		"application/x-xmind": "xmind",
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"audio/mpeg": "mp3",
		"audio/x-m4a": "m4a",
		"audio/wav": "wav",
		"audio/aac": "aac",
	};
	if (contentType) {
		const ct = contentType.split(";")[0].trim().toLowerCase();
		if (ctMap[ct]) return ctMap[ct];
	}
	const fromTitle = /\.(pdf|docx?|pptx?|xlsx?|epub|xmind|png|jpe?g|webp|gif|m4a|mp3|wav|aac|txt|md|html?)$/i.exec(
		fallbackTitle || "",
	);
	if (fromTitle) return fromTitle[1].toLowerCase();
	try {
		const path = new URL(url).pathname;
		const m = /\.([a-z0-9]{2,5})$/i.exec(path);
		if (m) return m[1].toLowerCase();
	} catch {
		// ignore
	}
	return "bin";
}

export function showErr(err: unknown, context: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[IMA Sync] ${context}:`, err);
	new Notice(`IMA Sync｜${context}：${msg}`, 8000);
}
