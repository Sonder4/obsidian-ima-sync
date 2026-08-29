# 致腾讯 ima 团队：OpenAPI 功能申请（草稿）

> 用途：通过官方渠道（ima 客户端内反馈、ima.qq.com 客服或 OpenAPI 合作通道）提交。
> 以下内容可直接复制发送。

---

您好，

我们是基于 ima OpenAPI（agent-interface，skill 版本 1.1.9）开发知识库自动化工具的开发者。OpenAPI 目前的知识库接口覆盖了「新增与读取」（add_knowledge / import_urls / get_knowledge_list / get_media_info），但缺少**删除与更新**能力，导致自动化场景存在以下痛点：

1. **无法删除**：自动化上传的测试/过期内容只能逐个在客户端手动删除；错误导入的网页也无法程序化清理。
2. **无法更新**：文档修改后只能重复新增，知识库中产生大量同名副本，污染检索质量（check_repeated_names 已经在提示重复，但没有处理手段）。

**申请**：在 `/openapi/wiki/v1/` 下开放（或告知规划）：

- `del_knowledge`（删除条目，支持批量 media_ids）
- `update_knowledge` 或 `replace_knowledge`（以新内容替换已有条目）

可选的约束建议（我们都接受）：
- 限定仅可操作「通过同一 OpenAPI 凭证上传的条目」（上传时记录归属）
- 删除操作进入客户端可见的回收站
- 更低的 QPS 配额

当前客户端 Web 层已存在对应内部接口（del_knowledge / replace_knowledge 等），说明能力已在服务端就绪，希望 OpenAPI 能尽快覆盖。谢谢！

---

**附：本插件现状**（可选一并说明）
- 开源插件：Obsidian ↔ ima 双向同步（下行用官方 OpenAPI，上行新增亦为官方接口）
- 更新场景目前只能「跳过并提示」或「副本上传」，急需删除/更新接口
