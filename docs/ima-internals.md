# ima 客户端内部接口分析笔记

> 本文记录对 **ima.copilot Windows 客户端** Web 层的互操作性分析，目的是为本插件的「删除/真更新」能力提供依据。
> 所有信息来自客户端在本机缓存中的 Web 脚本（明文可读），未对任何服务端进行攻击性测试。
> ⚠ 这些接口**不在官方 OpenAPI 承诺范围内**，腾讯可能随时变更；生产使用请以 [官方 OpenAPI](https://ima.qq.com/agent-interface) 为准。

## 客户端架构

- `ima.copilot.exe` 是 **Chromium 壳**（chrome.dll + 版本化目录），无 Electron/asar
- 业务 UI 为 Web 应用，业务 JS 存在于 `User Data\Default\Service Worker\ScriptCache` 与 `Code Cache`
- 运行日志 `imainfo/*_bin.log` 为加密二进制
- 客户端主进程监听本地 HTTPS 端口（如 `127.0.0.1:5283`），用于 agent-interface 网页唤起本地客户端

## 知识库内部端点（对比官方 OpenAPI 的 8 个，共发现 21 个）

前缀：`https://ima.qq.com/cgi-bin/knowledge/`（Web 层 `KyUrlPrefix` 绑定为 `${host}/cgi-bin/`，知识服务在此基础上拼方法名）

| 方法 | 官方 OpenAPI | 说明 |
| --- | --- | --- |
| `add_knowledge` | ✅ | 添加知识 |
| `import_urls` | ✅ | 导入网页 |
| `del_knowledge` | ❌ | **删除条目**，body: `{knowledge_base_id, media_ids: []}` |
| `delete_knowledge_base` | ❌ | 删除整个知识库 |
| `replace_knowledge` | ❌ | **替换条目内容**：`{knowledge_base_id, origin_media_id, replace_info: {media_id, media_type, file_info: {content_type, cos_key, file_name, file_size}}}`（新文件需先走 create_media + COS） |
| `rename_knowledge` | ❌ | 重命名：`{knowledge_base_id, media_id, title, folder_id?, media_type?}` |
| `get_tags` / `search_tags` | ❌ | 标签列表（返回 `tagInfos`）/ 搜索（`{knowledge_base_id, query, cursor, limit}`） |
| `update_tags` | ❌ | 设置条目标签：`{knowledge_base_id, media_id, tags: []}` |
| `batch_update_tags` | ❌ | 批量设置：`{knowledge_base_id, media_ids: [], tags}`，返回 `results[media_id].retCode` |
| `del_tags` | ❌ | 删除标签：`{knowledge_base_id, tags: []}` |
| `rename_tag` | ❌ | 重命名标签：`{knowledge_base_id, origin_tag, new_tag}` |
| `copy_knowledge` | ❌ | **跨库复制**：`{media_ids: [], dst_knowledge_base_id, dst_folder_id?}`；异步任务可经 SSE `knowledge_tab_sse/resume_cross_kb_op` 轮询，`cancel_cross_kb_op {task_id}` 取消 |
| `create_knowledge_base` / `create_folder` / `set_knowledge_top` / `set_knowledge_base_top` | ❌ | 结构管理；`create_folder`: `{knowledge_base_id, folder_id(父，根目录=知识库ID), title}`；`set_knowledge_top`: `{knowledge_base_id, folder_id, media_id, is_top}` |
| `update_basic_info` / `update_knowledge_access_status` / `update_permission_info` | ❌ | 信息/权限（update_basic_info: `{name, description, cover?}`） |
| `import_notes` / `parse_knowledge` / `get_user_space` / `report_knowledge` | ❌ | 其他 |

另有非 knowledge 前缀：`/cgi-bin/file_manager/get_media`、`/cgi-bin/media_logic/parse_media` 等。

## 认证链

Web 层所有请求经 `KyServiceImpl`（基于 ky）发送，`beforeRequest` 钩子注入 `headerService.getHeader()`：

```
x-ima-cookie: <cookie 串>          ← 客户端 cookieService 组装（含 IMA-TOKEN、PLATFORM=H5、CLIENT-TYPE 等）
x-ima-bkn: <整数>                  ← 由 IMA-TOKEN 计算（见下）
from_browser_ima: 1
```

`getBkn` 算法（DJB2 变体，Web 层明文逻辑）：

```js
function getBkn(token) {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) hash += (hash << 5) + token.charCodeAt(i);
  return String(hash & 0x7fffffff);
}
```

与官方 OpenAPI（`ima-openapi-clientid` / `ima-openapi-apikey` 头）是**两套独立体系**：用 OpenAPI 凭证调内部端点返回 HTTP 404，不可互通。

## 安全通道（本插件不涉及）

路径前缀 `/cgi-bin/s/*` 走加密通道（握手头 `x-ima-cm` / `x-ima-ckey` / `x-ima-ctk`，加密由客户端原生桥 cryptoService 提供）。知识库接口不在此前缀下，为普通 HTTPS + 上述认证头。

## 本插件的集成方式（Cookie 模式）

1. 用户在浏览器登录 ima.qq.com，从 DevTools 复制**自己的** Cookie（yt-dlp cookies.txt 同款模式）
2. 粘贴进插件设置；插件从中提取 `IMA-TOKEN` 计算 bkn，组装上述认证头
3. 能力范围严格受限：**只删除 `upIndex` 中记录的、插件自己上传的 media_id**（用于「真更新 = 删旧 + 原名重传」）；下行同步的本地内容永不触发云端删除
4. Cookie 失效时功能自动降级回「副本上传/跳过」并提示

## 风险声明

- 内部端点无兼容性承诺，客户端更新可能使其失效
- 调用模式与客户端不同（无完整设备指纹），理论上存在被风控识别的可能，请自行评估
- 删除操作不可逆（官方无回收站 API），插件侧已用「仅限自上传内容」收敛风险
