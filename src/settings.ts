export interface UpMapping {
	// vault 内文件夹路径（相对 vault 根）
	folder: string;
	// ima 知识库 ID
	kbId: string;
}

export interface DownIndexEntry {
	// vault 内文件路径
	path: string;
	kbId: string;
	// 下载到的媒体种类：md（网页/笔记/文本转换）、file（二进制存根）、stub（无原文）
	kind: "md" | "file" | "stub";
	title: string;
	syncedAt: number;
}

export interface UpIndexEntry {
	mediaId: string;
	kbId: string;
	// 上传时内容的 sha1，用于变更检测
	hash: string;
	// 若因重名/副本策略上传为新副本，记录该副本的 vault 源路径
	uploadedAs?: string;
}

export interface NoteIndexEntry {
	path: string;
	modifyTime: number;
}

export interface ImaSyncSettings {
	clientId: string;
	apiKey: string;
	// 用户勾选要下行同步的知识库
	selectedKbIds: string[];
	// 每个知识库对应的 vault 根文件夹
	kbFolders: Record<string, string>;
	// 上行映射：vault 文件夹 → 知识库
	upMappings: UpMapping[];
	// 同步 ima 个人笔记（只读下行）
	syncNotes: boolean;
	notesFolder: string;
	// 自动同步
	autoSync: boolean;
	intervalMinutes: number;
	// 二进制附件（PDF/Word 等）的保存目录
	attachmentFolder: string;
	// 已上传文件的修改重新上传为新副本
	reuploadChanged: boolean;
	// 跳过来自 ima 的文件（frontmatter 含 ima_media_id / ima_note_id），防止回环
	skipImaFiles: boolean;
	// 同步索引
	downIndex: Record<string, DownIndexEntry>;
	upIndex: Record<string, UpIndexEntry>;
	noteIndex: Record<string, NoteIndexEntry>;
	// 设置页缓存的知识库列表（id/name）
	kbListCache: { id: string; name: string }[];
}

export const DEFAULT_SETTINGS: ImaSyncSettings = {
	clientId: "",
	apiKey: "",
	selectedKbIds: [],
	kbFolders: {},
	upMappings: [],
	syncNotes: false,
	notesFolder: "20-ima/个人笔记",
	autoSync: true,
	intervalMinutes: 15,
	attachmentFolder: "90-Attachment/ima",
	reuploadChanged: false,
	skipImaFiles: true,
	downIndex: {},
	upIndex: {},
	noteIndex: {},
	kbListCache: [],
};
