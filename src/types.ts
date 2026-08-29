// IMA OpenAPI 类型定义（依据 ima-skill 1.1.9 references/api.md 及实测响应）

export interface ImaResponse<T = Record<string, unknown>> {
	code: number;
	msg: string;
	data: T;
	request_id?: string;
}

export interface AddableKnowledgeBaseInfo {
	id: string;
	name: string;
}

export interface KnowledgeBaseInfo {
	id: string;
	name: string;
	cover_url: string;
	description: string;
	recommended_questions: string[];
}

// get_knowledge_list 返回的条目：文件与文件夹混排
export interface KnowledgeListItem {
	media_id: string;
	title: string;
	parent_folder_id: string;
	tags?: string[];
	// 99 = 文件夹（实测）；其余见 MediaType
	media_type: number;
}

export interface FolderInfo {
	folder_id: string;
	name: string;
	file_number: string;
	folder_number: string;
	parent_folder_id: string;
	is_top: boolean;
}

export interface KnowledgeListData {
	knowledge_list: KnowledgeListItem[];
	is_end: boolean;
	next_cursor: string;
	current_path: FolderInfo[];
	searched_tags?: string[];
}

export interface URLInfo {
	url: string;
	headers: Record<string, string>;
}

export interface MediaInfoData {
	media_type: number;
	url_info?: URLInfo | null;
	notebook_ext_info?: { notebook_id: string } | null;
}

export interface AddableKbListData {
	addable_knowledge_base_list: AddableKnowledgeBaseInfo[];
	next_cursor: string;
	is_end: boolean;
}

export interface CreateMediaData {
	media_id: string;
	cos_credential: CosCredential;
}

export interface CosCredential {
	token: string;
	secret_id: string;
	secret_key: string;
	start_time: number;
	expired_time: number;
	appid: string;
	bucket_name: string;
	region: string;
	custom_domain: string;
	cos_key: string;
}

export interface AddKnowledgeData {
	media_id: string;
}

export interface CheckRepeatedNamesResult {
	name: string;
	is_repeated: boolean;
}

export interface FileInfoParam {
	cos_key: string;
	file_size: number;
	last_modify_time: number;
	password?: string;
	file_name: string;
}

// ---- notes 模块 (/openapi/note/v1) ----

export interface NoteBookInfo {
	note_id: string;
	title: string;
	summary: string;
	create_time: number; // ms
	modify_time: number; // ms
	cover_image: string;
	note_ext_info?: { folder_id: string; folder_name: string };
}

export interface ListNoteData {
	note_book_list: NoteBookInfo[];
	is_end: boolean;
}

export interface GetNoteContentData {
	content: string;
}

export interface ImportNoteData {
	note_id: string;
}

// MediaType 枚举（节选插件会用到的）
export const MediaType = {
	PDF: 1,
	WEB: 2,
	WORD: 3,
	PPT: 4,
	EXCEL: 5,
	WECHAT: 6,
	MARKDOWN: 7,
	IMAGE: 9,
	NOTE: 11,
	TXT: 13,
	XMIND: 14,
	AUDIO: 15,
	HTML: 20,
	EPUB: 21,
	FOLDER: 99,
} as const;
