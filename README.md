# obsidian-ima-sync

腾讯 ima 知识库 ↔ Obsidian 双向同步插件。基于 ima 官方 OpenAPI（[ima skill](https://app-dl.ima.qq.com/skills/ima-skills-1.1.9.zip) 内置文档）开发。

## 功能

- **下行（ima → vault）**：按用户勾选的知识库定时同步，镜像子文件夹结构；网页/微信文章转 Markdown（DOMParser 实现），Markdown/TXT 原样保留，PDF/Word/PPT 等存入附件目录并生成带链接的存根笔记；frontmatter 记录 `ima_media_id` / `ima_kb_id` / 标签等
- **上行（vault → ima）**：映射 vault 文件夹 → 知识库，新 Markdown 自动 `create_media → COS 签名上传 → add_knowledge`（media_type=7）；重名检查、内容哈希变更检测
- **真更新（可选）**：在设置中粘贴自己的 ima.qq.com 网页会话 Cookie 后，已上传文件的修改自动「删除旧版 + 原名重传」，不再产生副本。能力严格限定于插件自己上传的文档；留空则完全关闭、行为与官方 API 一致。原理与风险见 [docs/ima-internals.md](docs/ima-internals.md)
- **个人笔记下行**（可选）：`list_note` + `get_doc_content`，按 `modify_time` 增量
- **安全边界**：删除不双向传播；来自 ima 的文件默认不回传（防回环）；官方 API 无更新/删除端点，未启用真更新时已上传文件的修改默认跳过并提示

## 构建

```bash
npm install
npm run build   # 产物 main.js → 拷贝到 vault 的 .obsidian/plugins/obsidian-ima-sync/
```

## 测试

```bash
npx esbuild src/cos.ts --bundle --format=cjs --outfile=test/cos-test.cjs "--alias:obsidian=./test/obsidian-stub.js"
node test/verify-crypto.cjs   # SHA-1/HMAC/COS 签名 vs node crypto 参照
node test/e2e-upload.cjs      # 真实上行链路（会向知识库上传一个测试文档）
```

## API 要点（源自实测）

- 认证：Header `ima-openapi-clientid` / `ima-openapi-apikey`，全部 POST JSON 到 `https://ima.qq.com`
- 知识库：`/openapi/wiki/v1/*`（`get_addable_knowledge_base_list`、`get_knowledge_list`、`get_media_info`、`create_media`、`add_knowledge`、`check_repeated_names`）
- 笔记：`/openapi/note/v1/*`（`list_note`、`get_doc_content`）
- 实测与文档的差异：文件夹在 `get_knowledge_list` 中以 `media_type=99` 混排，其 `media_id`（`folder_*`）即子级 `folder_id`；根目录 `folder_id` 是独立 ID，不等于知识库 ID
- 限流：约 2 QPS 串行 + 退避重试（110010/110013/110021/20002）
