# Changelog

## 未发布（0.1.0）

### P7 — Redis 客户端

- 引擎接缝：`ConnectionSession` 判别联合（sql | redis），SQL 路径零行为改动。
- 连接：standalone / Cluster / Sentinel 三模式；ACL、SSL/TLS（自签拒绝·放行）、SSH 隧道（含 Cluster/Sentinel over SSH 的 NAT map）、只读模式 fail-closed。
- 面板：服务器状态、CLI 控制台（命令补全 / 危险命令二次确认 / 只读拦截）、慢日志、命令日志、键浏览器。
- 键浏览：SCAN 分页 + 分隔符折叠 + 批量删除（按 pattern，count-only 预扫 + 计数确认）+ 大 key 保护；string/hash/list/set/zset/stream 查看编辑、TTL、新建/重命名/删除。
- 二进制：string 支持字节级 hex 编辑；有损（非 UTF-8）键/成员只读 + 删除计数校验。

### P7.1 — PostgreSQL 多 schema 与多库

- 多 schema：树 `库 → Schema → 分类 → 对象`（`public`/连接默认 schema 置顶、系统 schema 不列）；写/DDL/导出/数据编辑按 `"schema"."对象"` 限定（含外键跨 schema、视图定义按 oid、触发器按 schema+表）。
- 多库：浏览该连接可见的全部库（按 CONNECT 权限过滤）；按库懒建会话（上限 4 + LRU），SSH 隧道引用计数复用；「在该库执行」（不提供 `USE`）。
- 定时备份：PG 逐 schema 备份（目标相对，可恢复到任意目标 schema）；导入 SQL 脚本/恢复按目标 schema 设 `search_path`。
- 不支持：PG 跨库结构/数据对比（明确拒绝）。

### P8 — Elasticsearch 客户端

- 新引擎：Elasticsearch（http/https、Basic/ApiKey、TLS、SSH 隧道、只读）；`ConnectionSession` 判别联合扩第三种，SQL/Redis 路径零行为改动。
- db-core：`EsClient` 零依赖（Node 内置 http/https）统一请求封装 + 请求日志 + 只读切面（fail-closed）+ 危险判定。
- 面板：集群总览、索引列表/详情（mapping/settings/aliases 只读）、文档 `search_after` 分页 + CRUD、DSL 查询控制台、REST 控制台（任意 method/path/body）、节点、请求日志。
- 安全：只读切面 fail-closed（GET/HEAD 恒放行；非 GET 仅 POST 且命中读路径白名单；`/_nodes` 管理端点、`_bulk` 等 403，可单条解锁）；危险操作 host 侧确认（DELETE index 需输入索引名）；写请求落审计。
- 修复（复核）：并发 REST 请求不再互相取消（每请求独立 AbortController + 面板关闭统一 abort）；REST 控制台 Enter/历史双击不再绕过在途守卫；面板销毁后不再回写消息；ES 相关文案全部入 i18n。

### 同步前提（D15）

- 本版按「**从未发布过启用同步的旧客户端**」处理，**未加服务端最低版本门禁**。若该前提被推翻，需回补服务端版本门禁。
- 已知限制：未使用 SQL 参数绑定（标识符走白名单 + 字面量转义）；放宽白名单前必须先改为参数绑定。