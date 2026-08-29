# 架构设计与决策记录

> 面向后续维护者：解释"为什么是这样"，以及各模块的职责边界与数据流。接口细节见 [ima-internals.md](ima-internals.md)，扩展方法见 [ROADMAP.md](ROADMAP.md)。

## 1. 总体架构

```
┌────────────────────────── Obsidian 插件进程 ──────────────────────────┐
│                                                                        │
│  main.ts ── 命令/ribbon/定时器 ── runSync(all|down|up)                 │
│     │                                                                  │
│     ├── settings.ts      配置 + 同步索引（data.json 持久化）           │
│     ├── settingsTab.ts   设置 UI（凭证/勾选知识库/映射/Cookie）        │
│     ├── commands.ts      知识库管理命令（Cookie 模式，作用于活动笔记）  │
│     │                                                                    │
│     ├── api.ts   ImaClient ─── 官方 OpenAPI（ima-openapi-* 头）        │
│     ├── cgi.ts   ImaCgiClient ─ 内部 CGI（x-ima-cookie/x-ima-bkn 头）  │
│     ├── cos.ts  COS PUT 签名上传（纯 JS SHA-1/HMAC，无 Node 依赖）      │
│     │                                                                    │
│     ├── down.ts  下行引擎：遍历知识库 → 取原文 → 写 vault               │
│     ├── up.ts    上行引擎：扫描文件夹 → 变更检测 → 上传                  │
│     └── convert.ts  HTML→MD（DOMParser）+ frontmatter 工具             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
         │                              │
   ima.qq.com/openapi/wiki/*      ima.qq.com/cgi-bin/*
   （官方 OpenAPI，稳定）        （客户端原生接口，能力全但无兼容承诺）
```

### 双通道设计（核心决策）

| | 官方 OpenAPI 通道 | 内部 CGI 通道 |
| --- | --- | --- |
| 认证 | Client ID + API Key（长期有效） | 用户会话 Cookie（约 2h 过期，可刷新） |
| 能力 | 增删读（无改名/标签/复制/文件夹） | 全量管理能力 |
| 稳定性 | 官方承诺 | 无承诺，随客户端更新可能变化 |
| 命名空间 | OpenAPI 命名空间 | 内部命名空间（**与官方互不可见**） |
| 插件中的角色 | 默认通道：下行、未配 Cookie 时的上行 | Cookie 模式：管理命令、内部上传、真更新 |

**决策依据**：官方 API 缺管理能力（无删除/改名/标签），而管理是本插件的核心诉求；逆向分析确认内部接口服务端已就绪且可复刻认证。为兼顾稳定性与能力，采用"官方保底、Cookie 解锁增强"的渐进设计——Cookie 留空时插件是纯官方 API 工具。

**命名空间规则（实测）**：两个通道的媒体互相不可见。官方上传的文档内部接口查不到（报 500010）；因此 Cookie 模式下的上行**必须走内部通道**（`cgi.uploadMarkdown`），否则上传物无法改名/删除。下行读取继续走官方（内部无等价的分页全量列表带解析状态）。

## 2. 模块职责与数据流

### 下行（down.ts）

```
勾选的知识库 → get_knowledge_list 递归遍历（folder 的 media_type=99，media_id 即子级 folder_id）
  → 每条目 get_media_info：
      ├─ notebook_ext_info（笔记类）→ notes.get_doc_content → 写 .md
      ├─ url_info.url（可下载）→ 按类型分派：
      │     网页/HTML → DOMParser → Markdown
      │     md/txt → 原样写入
      │     PDF/Word/… → 存附件目录 + 生成带链接的存根笔记
      └─ 无 url_info → 存根笔记「请在 ima 客户端查看」
  → 写 frontmatter（ima_media_id/ima_kb_id/ima_type/tags/synced）
  → downIndex[media_id] = {path, kbId, ...}（data.json 持久化）
```

增量策略：**存在即跳过**（条目无可靠更新时间）；远端删除本地保留。首次全量约 2 QPS 限速（309 条 ≈ 10 分钟）。

### 上行（up.ts）

```
upMappings（vault 文件夹 → 知识库）→ 递归收集 .md
  → 过滤：skipImaFiles（frontmatter 含 ima_media_id/ima_note_id 的防回环跳过）
  → 分拣：upIndex 无记录=新增；hash 相同=跳过；hash 变化=真更新/副本/提示（按配置与 Cookie）
  → 新增批量 check_repeated_names 重名检查
  → 上传：
      Cookie 模式 → cgi.uploadMarkdown（file_manager/create_media → COS PUT
                    → knowledge_tab_writer/add_knowledge，服务端分配内部 media_id）
      官方模式   → api.createMedia → COS PUT → api.addKnowledge（官方 media_id）
  → upIndex[path] = {mediaId, kbId, hash}
```

**真更新**（Cookie 模式）：`del_knowledge(旧内部 media_id)` → 内部重传 → 更新 upIndex。仅当 `prev.kbId === cgi.personalKbId`（内部命名空间）时可用；官方通道上传的旧文档内部不可见，只能副本模式。

### 知识库管理命令（commands.ts）

作用对象 = 当前活动笔记（frontmatter 定位）。Cookie 模式下内部 media_id 与官方不同，统一经 `resolveInternal()`：按笔记标题调 `search_knowledge` 解析出 `{kbId=UID, mediaId, folderId, mediaType}`；找不到时明确提示"官方上传内容对内部接口不可见，请先走一次内部通道上行"。

## 3. 关键决策记录（ADR 摘要）

| # | 决策 | 理由 | 后果 |
| --- | --- | --- | --- |
| 1 | Cookie 模式而非凭据提取 | 从客户端加密存储抠会话 = 击穿凭据保护，封号风险高且极脆弱；用户自愿粘贴自己的会话（yt-dlp cookies 模式）是干净边界 | 用户需手动扫码+粘贴，约 2h 过期后重贴 |
| 2 | 删除能力只作用于插件自上传内容 | 删除不可逆且服务端无回收站保证；下行内容是用户原始资料，误删无法挽回 | 命令层经 resolveInternal 限定；真更新仅限 upIndex 记录 |
| 3 | 删除不双向传播 | 同上；下行"存在即跳过"天然规避 | 云端删本地留、本地删云端留 |
| 4 | COS 签名纯 JS 实现（不用 node:crypto） | 兼容移动端（Node API 不可用）；实现已与 node crypto 及真实上传对拍 | 代码较长（cos.ts），改动需跑 verify-crypto.cjs |
| 5 | 同步索引存 data.json 单文件 | 实现简单、随插件备份；量级（数百条）无性能问题 | **运行中的实例会在任意 saveSettings 时覆盖外改**——外部修改 data.json 必须先卸载插件（关 vault 窗口） |
| 6 | 上传通道跟随 Cookie | 内部命名空间才能被管理命令操作 | 无 Cookie 时上传物只能"副本式"更新 |
| 7 | `replace_knowledge` 不使用 | 实测稳定返回 600100（服务端问题） | 真更新 = del + add（两者均已实测可靠） |

## 4. 状态与索引 schema

```jsonc
// data.json（部分）
{
  "clientId": "…", "apiKey": "…", "webCookie": "…",
  "selectedKbIds": ["…官方KB ID"],        // 下行勾选
  "kbFolders": { "<官方KB ID>": "20-ima/名称" },
  "upMappings": [{ "folder": "01-Daily", "kbId": "…" }],
  "downIndex": { "<官方media_id>": { "path": "…", "kbId": "…", "kind": "md|file|stub", "title": "…", "syncedAt": 0 } },
  "upIndex":   { "<vault路径>": { "mediaId": "…", "kbId": "…", "hash": "sha1", "uploadedAs": "副本名?" } },
  "noteIndex": { "<note_id>": { "path": "…", "modifyTime": 0 } },
  "kbListCache": [{ "id": "…", "name": "…" }]
}
```

注意 `kbFolders`/`selectedKbIds` 用**官方 ID**；Cookie 模式下个人库内部 ID 是 UID（`cgi.personalKbId`），两者不混用。

## 5. 安全模型

- 凭证（OpenAPI Key、会话 Cookie）只存 `data.json` + `~/.config/ima/`，均已 gitignore；提交前执行密钥扫描（见 ROADMAP 发布清单）
- 会话 Cookie 仅发送至 `ima.qq.com`；COS 上传使用一次性临时凭证
- 破坏性操作（删除/覆盖）三类防线：作用域限制（仅自上传内容）→ 输入确认（标签删除需输入标签名）→ 服务端业务校验

## 6. 已知运行环境陷阱（实测踩坑）

1. **禁止动态 `import("obsidian")`**——渲染进程无法解析模块说明符，必须静态导入（历史上导致全量下载失败）
2. **插件 main.js 只在窗口/应用启动时加载**：改 data.json 或换 main.js 后，唯一可靠重载方式 = 关闭 vault 窗口再以 `obsidian://open?vault=…` 重开；Ctrl+R 与改 community-plugins.json 均不可靠
3. 外部改 `data.json` 必须在插件未加载时进行（运行中实例的 saveSettings 会覆盖外部修改）
4. `checkCallback` 的 checking 阶段不得弹 Notice（命令面板每次渲染都会调用）
5. Windows 下 Git Bash 对 100MB 级目录 grep 极慢——大目录二进制扫描用 Python
