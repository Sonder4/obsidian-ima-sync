# obsidian-ima-sync

腾讯 ima 知识库 ↔ Obsidian 双向同步插件。双通道设计：**官方 OpenAPI**（稳定读取/下行）+ **客户端原生 CGI 接口**（可选，解锁删除/改名/标签/跨库复制等管理能力，基于 ima 桌面端 5.8.6 扩展逆向与真实流量实测，见 [docs/ima-internals.md](docs/ima-internals.md)）。

## 功能总览

| 模块 | 方向 | 认证 | 说明 |
| --- | --- | --- | --- |
| 知识库下行 | ima → vault | OpenAPI | 按勾选的知识库增量同步，镜像子文件夹；网页转 Markdown；PDF/Word 等附件本地化 + 存根笔记 |
| 笔记下行（可选） | ima → vault | OpenAPI | ima 个人笔记只读同步，按 modify_time 增量 |
| 笔记上行 | vault → ima | OpenAPI 或 CGI | 映射 vault 文件夹 → 知识库；配置 Cookie 后自动走内部通道（上传物可管理） |
| 真更新（可选） | vault → ima | CGI | 已上传文件的修改 = 删除旧版 + 原名重传，无副本残留 |
| 知识库管理（可选） | 双向操作 | CGI | 标签编辑/管理、重命名、内容替换、新建文件夹/知识库、跨库复制、删除 |

**所有可选能力以 Cookie 为开关**：设置中粘贴 ima.qq.com 会话 Cookie 即激活；留空 = 纯官方 API 行为。

## 快速开始

1. **构建**：`npm install && npm run build`（产物 `main.js` 拷入 vault 的 `.obsidian/plugins/obsidian-ima-sync/`）
2. **凭证**：设置 → IMA Sync → 粘贴 Client ID + API Key（[获取入口](https://ima.qq.com/agent-interface)）→ 点「验证并刷新知识库列表」
3. **勾选知识库**：下行区勾选要同步的仓库，设置目标文件夹（默认 `20-ima/知识库名`）
4. **（可选）激活管理能力**：浏览器登录 ima.qq.com → F12 → Network → 复制首个请求的整行 Cookie 值 → 粘贴到「网页会话 Cookie」→ 点「测试网页会话」
5. **自动同步**：默认 15 分钟，可调；ribbon ⟳ 或命令面板（搜 "ima"）手动触发

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计、模块职责、数据流、关键决策记录（ADR 风格） |
| [docs/ima-internals.md](docs/ima-internals.md) | ima 内部接口参考（实测核对的路径/参数/认证/错误码/命名空间规则） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 扩展手册：已知缺口、新增能力教程、调试方法、避坑清单、发布清单 |
| [docs/openapi-feature-request.md](docs/openapi-feature-request.md) | 致 ima 官方的删除/更新接口申请草稿 |

## 同步规则（重要）

- 下行为增量拉取：已同步条目跳过；云端删除**不影响本地**；本地删除不回传云端
- 上传默认只推新文件；Cookie 模式下「真更新」仅作用于**插件自己上传的文档**
- 防回环：下行文件带 `ima_media_id`/`ima_note_id` frontmatter，默认不回传
- 凭证只存本地 `data.json`（已 gitignore）

## 开发

```bash
npm install
npm run build          # tsc 类型检查 + esbuild 打包
node test/verify-crypto.cjs   # SHA-1/HMAC/COS 签名对拍（需先构建 cos-test.cjs，见文件内说明）
node test/e2e-upload.cjs      # 官方通道真实上传 E2E（读 ~/.config/ima 凭证 + IMA_KB_ID 环境变量）
```

欢迎 Issue/PR。提交前请确认：不含任何真实凭证；`npm run build` 通过；改动涉及 ima 接口时同步更新 `docs/ima-internals.md`。

## License

MIT
