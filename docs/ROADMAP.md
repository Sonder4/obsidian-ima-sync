# 扩展手册与路线图（ROADMAP）

> 给后续更新/扩展的准备材料：当前缺口、新增能力的标准做法、调试与再验证方法、避坑清单、发布清单。
> 接口字段查 [ima-internals.md](ima-internals.md)；架构决策查 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 已知缺口（按价值排序）

| 缺口 | 现状 | 建议方案 |
| --- | --- | --- |
| 会话过期需手动重贴 Cookie | token 2h / refreshToken 30d | 实现 `auth_login/refresh` 自动刷新（body `{user_id, refresh_token, token_type:14}`，web_session.json 已存 refreshToken）；过期前静默续期 |
| 频控码 200001 未重试 | 只重试 110021/20002/110010/110013 | 加入 RETRYABLE_CODES 并用长退避（30s/60s/120s）；连续 N 次频控则中止本轮同步 |
| 首次全量同步对服务端压力大 | 2 QPS 串行打满 | 增加「首同步慢速模式」：间隔 1s+，分批（每 50 条歇 30s） |
| replace_knowledge 不可用 | 600100 恒定返回 | 已用 del+add 替代；服务端修复后可切回（省一次删除） |
| 个人笔记无上行 | 官方 notes 模块只有 import/append | 新笔记 import_doc + 记 note_id；后续修改 append_doc 追加变更段（无覆盖能力） |
| 共享知识库支持不完整 | get_home_page_data 的 type 1002/1004/1005（共享/加入的库）未接 | 下行勾选列表接入 get_home_page_data 的分类；共享库无写权限（服务端 110030） |
| 文件夹级操作 | 只实现了 create_folder | 文件夹移动/重命名（rename_knowledge 对 folder_* 同样适用，待实测） |
| 命令作用于活动笔记，无批量界面 | 单笔记粒度 | 文件多选 + 批量标签（batch_update_tags 已具备） |
| 上行映射目标限个人库 | Cookie 模式上传固定写 UID | 共享库需走官方通道；映射设置中标注库类型 |

## 2. 新增一个 CGI 能力的标准流程

1. 在扩展源码（`User Data\Default\Extensions\nkohmbngmopdajidckglcoehlaeepeoi\<ver>\assets\ai-chat-ui-*.js`，明文可读）找目标方法：搜 `` `urlPrefix}/<method>` ``，确认其所属服务类（writer/reader/file_manager 决定前缀）
2. 找**调用点**拿字段名：搜 `.<methodName>(\s*{`；注意 `U()/snakify` 会把 camelCase 转 snake_case
3. 在 `src/cgi.ts` 加方法（套用现有 `post()` 模板）
4. **先探测后实装**：用假 ID 调用——鉴权/路径正确时返回业务错误（51/500010 等），路径错误返回 404 空体
5. 真实数据验证 → 更新 `docs/ima-internals.md` 字段表 → 单独一个 commit

## 3. 调试方法（客户端更新后如何重新分析）

### 3.1 桌面客户端流量捕获（最强证据）

1. 扩展目录（解包明文）：`%LOCALAPPDATA%\ima.copilot\User Data\Default\Extensions\nkohmbngmopdajidckglcoehlaeepeoi\<ver>\`
2. 备份后向 `assets/injected-script.js` 追加捕获器（index.html 第一个加载的模块）：包装 `window.fetch` 与 `XMLHttpRequest`，把含 `/cgi-bin/` 的请求（完整头+体）存入数组
3. 导出三通道任选：`chrome.downloads.download`（下载目录）、`navigator.clipboard.writeText`（剪贴板）、`document.title`（探针，如 `IMA-CAP n=3`，经窗口标题读取确认挂钩是否生效）
4. 重启客户端 → 打开知识库窗口 → 触发目标操作 → 收集数据
5. **完成后务必恢复原文件并重启客户端**（本次会话曾因没过滤 URL 把遥测也记进来； 且捕获钩子残留在运行实例内存中）
6. localStorage 导出会落进 LevelDB（UTF-16LE + 32KB 分块），需按 LevelDB log 格式解析（见会话记录），**下载/剪贴板通道可完全绕开该解析**

### 3.2 Web 版辅助（仅登录态/部分接口）

ZCode IAB 打开 ima.qq.com → 微信扫码 → 页面内 evaluate 注入 fetch 记录器 → 点侧栏「知识库」。注意：网页版看不到文件内容、部分管理页不可用；且 HttpOnly cookie 无法用 document.cookie 读取（会话要从 localStorage accountInfo 或抓包获得）。

### 3.3 无效手段（勿再尝试）

- `--remote-debugging-port`：此壳禁用 DevTools server
- 官方 OpenAPI 凭证调内部路径：404
- 编辑 `community-plugins.json`/Ctrl+R 热重载 Obsidian 插件：无效，必须重开 vault 窗口

## 4. 测试清单

| 脚本/步骤 | 验证内容 | 依赖 |
| --- | --- | --- |
| `npm run build` | 类型 + 打包 | — |
| `node test/verify-crypto.cjs` | SHA-1/HMAC/COS 签名 vs node:crypto | 先 esbuild 出 test/cos-test.cjs |
| `node test/e2e-upload.cjs` | 官方通道上传 E2E | `~/.config/ima/` 凭证 + 环境变量 IMA_KB_ID |
| `node test/cgi-probe.mjs` | CGI 认证探测 | `~/.config/ima/web_session.json`（含 cookie/bkn/uid） |
| 设置页「测试网页会话」 | 插件内 Cookie 有效性（probe 无副作用） | data.json 已配置 |
| Obsidian 命令面板搜 "ima" | 7 个管理命令出现；条件命令需活动笔记 | — |

**写接口实测矩阵**（2026-08-29，客户端 2.6.7.4998 / 扩展 5.8.6）：search_tags ✅ update_tags ✅ rename_knowledge ✅ create_folder ✅ copy_knowledge ✅ del_knowledge（文档+文件夹）✅ create_knowledge_base ✅ delete_knowledge_base ✅ 内部上传链路 ✅ replace_knowledge ❌600100。客户端升级后建议按此表回归。

## 5. 发布清单（发版前）

1. `npm run build` 通过；`git grep` 确认无真实凭证/UID/token 片段
2. 敏感文件核对：`data.json`、`web_session.json`、`~/.config/ima/*` 均不在仓库内
3. 若改了 ima 接口：`docs/ima-internals.md` 字段表 + 实测矩阵同步更新
4. manifest.json 版本号 + 本 README 功能表同步
5. tag + GitHub Release（附件：main.js / manifest.json / styles.css）， Obsidian 市场提交需先满足其审查要求（无网络遥测、最小权限等）

## 6. 设计红线（勿越）

- 不从 ima 客户端加密存储提取会话；只接受用户自愿提供的凭证
- 删除/覆盖只作用于插件自己上传的对象；下行内容永不触发云端写操作
- 不绕过加密通道（/cgi-bin/s/*）与任何风控机制；接口变更时降级而非对抗
