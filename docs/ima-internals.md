# ima 内部接口参考（实测终版）

> 来源：桌面客户端 5.8.6 内置扩展（`IMA知识库`，chrome-extension://nkohmbngmopdajidckglcoehlaeepeoi）源码 + 真实流量捕获，**全部经真实调用验证**。
> ⚠ 无兼容承诺，客户端更新可能变化；生产优先使用官方 OpenAPI。
> 分析方法论与再验证方法见 [ROADMAP.md §调试方法](ROADMAP.md)。

## 1. 服务器与路径

- 生产主机：`https://ima.qq.com`（测试/预发：ima-test / ima-pre.qq.com）
- 知识写服务：`/cgi-bin/knowledge_tab_writer/<方法>`
- 知识读服务：`/cgi-bin/knowledge_tab_reader/<方法>`
- 文件服务：`/cgi-bin/file_manager/<方法>`（create_media、get_upload_credential、get_media）
- 登录刷新：`/cgi-bin/auth_login/refresh`（body `{user_id, refresh_token, token_type:14}`）
- 加密通道：仅 `/cgi-bin/s/*`（握手头 x-ima-cm/ckey/ctk，客户端原生桥加密）——知识接口**不在其中**
- 资源下载：`res-pkb.ima.qq.com`（需随带 `X-IMA-*` 签名头，来自 get_media_info 的 url_info.headers）

## 2. 认证（每次请求）

```
x-ima-cookie: PLATFORM=H5; CLIENT-TYPE=256021; WEB-VERSION=5.8.6; IMA-GUID=…; IMA-Q36=…;
              IMA-IUA=<设备串>; IMA-UID=<用户UID>; IMA-TOKEN=<token>; IMA-REFRESH-TOKEN=<refresh>;
              UID-TYPE=2; TOKEN-TYPE=14
x-ima-bkn:    getBkn(IMA-TOKEN)
from_browser_ima: 1
Content-Type: application/json
```

- `getBkn(token)`：`h=5381; h += (h<<5) + code; return h & 0x7FFFFFFF`（已与真实值对拍一致）
- **缺任一 cookie 字段 → `{"code":51,"msg":"参数错误"}`**（这是最常见的坑，不是真的参数问题）
- 会话来源：客户端登录态；网页扫码登录后 token 存于 `localStorage["ima-universal-local-storage-accountInfo"]`（token 2h / refreshToken 30d，tokenType 14）
- token 刷新：`POST /cgi-bin/auth_login/refresh`，body 同上，响应 Set-Cookie 更新会话

## 3. ID 体系与命名空间（关键）

| 概念 | 规则 |
| --- | --- |
| 个人知识库 ID | 内部接口一律使用**用户 UID**（IMA-UID），不是官方加密 KB ID |
| 根目录 folder_id | = 用户 UID |
| 客户端创建内容的内部 media_id | 形如官方 ID 的尾部（如官方 `weburl_…_e5ea1225a671a71d3ccc` → 内部 `e5ea1225a671a71d3ccc`）；文件夹为 `folder_<数字>` |
| **命名空间隔离** | 官方 OpenAPI 上传的文档对内部接口**不可见**（读列表不显示、写操作报 500010）；内部接口也无法操作官方命名空间文档 |
| 结论 | 需要管理（改名/删除/标签）的上传必须走内部上传链路（§5） |

## 4. 写服务（knowledge_tab_writer，除注明外全部实测 ✅）

| 方法 | body（snake_case） | 返回/备注 |
| --- | --- | --- |
| `del_knowledge` | `{knowledge_base_id, media_ids: []}` | **文档与文件夹通用**；返回 `results[media_id].ret_code` |
| `update_tags` | `{knowledge_base_id, media_id, folder_id?, media_type?, tags: []}` | 覆盖式设置 |
| `batch_update_tags` | `{knowledge_base_id, media_ids: [], tags}` | 返回逐条成败 |
| `rename_knowledge` | `{knowledge_base_id, media_id, title, folder_id?, media_type?, action: 0, is_searching: false}` | action: 0=Default 1=Save |
| `create_folder` | `{knowledge_base_id, folder_id(父，根=UID), title}` | 返回完整 knowledge 对象（含 media_id=`folder_*`） |
| `copy_knowledge` | `{media_ids: [], dst_knowledge_base_id, dst_folder_id?}` | 返回新 media_ids；跨库同形 |
| `create_knowledge_base` | `{name}` | 返回 info（含 basic_info） |
| `delete_knowledge_base` | **`{id}`**（注意不是 knowledge_base_id） | — |
| `set_knowledge_top` | `{knowledge_base_id, folder_id, media_id, is_top}` | 未实测 |
| `add_knowledge` | `{knowledge_base_id, media_type: 7, title, folder_id?, file_info: {cos_key, file_size, last_modify_time, file_name}}` | 返回服务端分配的内部 media_id（**请求无需 media_id**） |
| `rename_tag` | `{knowledge_base_id, origin_tag, new_tag}` | — |
| `del_tags` | `{knowledge_base_id, tags: []}` | — |
| `replace_knowledge` | `{knowledge_base_id, origin_media_id, replace_info: {media_type, file_info}}` | ❌ 实测 600100 服务繁忙（重试同样），暂不可用 |
| `update_basic_info` | `{name, description, cover?}` | 未实测 |
| `cancel_cross_kb_op` | `{task_id}` | 取消复制任务 |

## 5. 读服务（knowledge_tab_reader）

| 方法 | body | 返回 |
| --- | --- | --- |
| `search_tags` | `{knowledge_base_id, query, cursor, limit}` | `searched_tags[].tag_info.tag` + 游标 |
| `search_knowledge` | `{knowledge_base_id, query, cursor}` | `searched_knowledge_list[].knowledge{media_id, title, media_type, parent_folder_id, tags}` |
| `get_knowledge_base_home_page` | `{knowledge_base_id, knowledge_list_req: {knowledge_base_id, folder_id, sort_type: 9, need_default_cover, cursor?}}` | `list_rsp.knowledge_list[]`（basic_info 含 media_id/title/media_type/parent_folder_id/tags）+ current_path + 游标 |
| `get_home_page_data` | `{knowledge_base_list_req: {params: [{type: 1001\|1002\|1004\|1005, cursor, limit}]}}` | 全部知识库列表（含共享库分类） |
| `get_knowledge` | `{knowledge_base_id, media_id, folder_id?}` | 单条详情 |
| `get_knowledge_list` | 同 home_page 的 knowledge_list_req | 纯列表 |

## 6. 文件服务（file_manager）

| 方法 | body | 返回 |
| --- | --- | --- |
| `create_media` | `{knowledge_base_id, file_name, file_size, content_type, file_ext, media_type: "MARKDOWN"}` | **media_type 是字符串枚举**（PDF/WEB/WORD/…/MARKDOWN/…）；返回 `cos_credential{bucket_name, region, cos_key, secret_id, secret_key, token, start_time, expired_time}`（时间戳为**字符串**） |
| `get_upload_credential` | 同上 | 同结构 |
| `get_media` | — | 下载地址 |

上传链路：`create_media` → COS PUT（签名同官方通道，见 src/cos.ts）→ `knowledge_tab_writer/add_knowledge`（**请求不含 media_id**，服务端按 cos_key 分配并返回）。

## 7. 官方 OpenAPI 通道（对照）

- 网关：`/openapi/wiki/v1/*`、`/openapi/note/v1/*`；头 `ima-openapi-clientid`/`ima-openapi-apikey`
- 与内部接口**互不认证、互不可见**（官方凭证调内部路径 404）
- 能力：get_addable_knowledge_base_list / get_knowledge_list / get_media_info / create_media / add_knowledge / check_repeated_names / search_*；notes: list_note / get_doc_content / import_doc / append_doc
- 无：删除、改名、标签、复制、文件夹、更新

## 8. 错误码速查（实测）

| code | 含义 | 处置 |
| --- | --- | --- |
| 51 | 参数错误（**最常见诱因是 x-ima-cookie 缺会话字段**） | 核对认证头完整性 |
| 500010 | 该数据不存在 | 多为拿官方 media_id 调内部接口（命名空间错位），或个人库没用 UID |
| 600100 | 服务繁忙（replace_knowledge 实测恒定返回） | 改用 del+add |
| 110021 / 20002 | 请求频控 | 退避重试（插件已内置） |
| 200001 | 请求频率超限 | **未加入插件重试表（TODO）**，出现时应长退避 |
| 404 空体 | 路径不存在或被隐藏 | 核对前缀（writer/reader/file_manager） |
