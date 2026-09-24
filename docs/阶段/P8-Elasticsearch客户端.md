# P8 — Elasticsearch 客户端

> 状态：draft v2（review 修订）。P7 引入的 EngineKind/ConnectionSession 判别联合是本阶段前置依赖，
> ES 接入后 `EngineKind = 'sql' | 'redis' | 'elasticsearch'`。本文档结构对齐 P7，先讲产品再讲设计与切片。
>
> 事实校对（v1→v2）：`ConnectionSession` 定义在 `apps/vscode-ext/src/connection/connectionSession.ts`
> （P7 从原 connectionManager.ts 拆出），不在 db-core；db-core 保持纯 SQL 形态，EngineKind 判别联合
> 落在 vscode-ext 层；HTTP 客户端用 Node 内置 https（零依赖），EsClient 放 db-core（与 redis/、SQL
> connection adapters 并列，纯 Node 零 vscode 依赖）。
>
> 对齐基线：es-client v3.2.3（Apache-2.0，`gitee.com/qiaoshengda/es-client` / `github.com/q2316367743/es-client`）。
> v1 定位为 **es-client 核心体验的子集**（不含 ILM/Index Template/导出/AI/Explain/Analyze，见 §十三）。

## 一、这个阶段要做什么

给 DevBelt 加一个 **Elasticsearch 客户端**，对齐 es-client v3.2.3
（Apache-2.0；[gitee 主仓](https://gitee.com/qiaoshengda/es-client) / [GitHub 镜像](https://github.com/q2316367743/es-client)，
Vue3+TS 轻量 ES 管理工具）的**核心体验子集**。

你平时查 ES 要开 Kibana / es-client / Elasticvue / Postman 调 REST。这个阶段把这件事做进 DevBelt：
**连接 ES 之后，能在 DevBelt 里直接看集群健康、浏览索引与 mapping、增删改查文档、用 DSL 查询。**
连接/分组/SSH/凭据/只读/审计/i18n 复用现有体系，HTTP 传输用 Node 内置 `https` 模块，零新依赖。

一句话：**P7 让 DevBelt 从 SQL 跨进 KV；P8 让 DevBelt 支持搜索引擎/文档数据库形态的第三种引擎。**

## 二、用户能做什么

### 连接管理

- **新建/编辑/删除/克隆/分组/搜索/颜色标签** ES 连接，和 MySQL/PG/SQLite/Redis 并列在侧栏「个人连接」树。
- **连接字段**：名称、协议（http/https，默认 http）、host、port（默认 9200）、路径前缀（可选，用于
  反代场景）。
- **认证**：无认证 / Basic Auth（username/password）/ API Key（Base64 `id:api_key` 或原始 api key
  字符串，客户端自动 Base64）。UI 单选认证方式，三选一。
- **SSL/TLS**：https 模式下可配 CA 文件、客户端证书、客户端私钥；「允许自签名证书」开关
  （`rejectUnauthorized:false`，默认关，有安全提示）。
- **SSH 隧道**：复用现有 SSH 配置；SSH 转发到 ES 端口。
- **只读模式**开关：拦截写/删/配置修改类 REST 方法。
- **测试连接**：表单内按钮，`GET /` 返回版本号即成功；认证失败、证书错误、连通失败给出明确错误。
- **凭据存储**：password 与 apiKey 走 VS Code SecretStorage，其他非敏感字段落 Memento（路径前缀、
  host/port/protocol/证书路径）。

### 集群总览

- 连接打开后默认进入「集群」tab：版本号（`version.number`）、集群名称、cluster health
  （green/yellow/red 颜色标）、节点数、data 节点数、active primary shards、active shards、
  relocating/initializing/unassigned shards、文档总数、索引总数。
- 节点列表 tab（`GET _cat/nodes?format=json&h=...`）：name/ip/role/heap.percent/ram.percent/
  cpu/load_1m/disk.used_percent/disk.total/node.role/version，按角色/负载排序。
- 右键连接节点菜单：集群总览、节点列表、REST 控制台、断开、编辑、克隆、删除。

### 索引浏览

- 展开连接节点显示「索引」类别节点，再下是索引节点（`GET _cat/indices?format=json&h=...`，列：
  health/status/index/uuid/pri/rep/docs.count/deleted.store.size/pri.store.size）。
- 索引列表支持搜索（按 index 名前缀/通配，客户端过滤即可，因为索引总数通常 <1w）、按列排序
  （docs/size/health）、刷新。
- health 点颜色（green 绿 / yellow 黄 / red 灰红）；status（open/close）列显示 open/close 标签。
- 点索引打开 ES 面板，默认进入该索引详情；面板顶栏可切换 tab：概览 / Documents / Mapping /
  Settings / Aliases / DSL 查询 / REST 控制台。

### 索引详情（概览 tab）

- `GET <index>` 返回的 settings/mapping/aliases 汇总：文档数、主分片数、副本数、创建时间、
  存储大小、aliases 列表。
- 右上角操作：刷新、强制合并、刷新（`POST <index>/_refresh`）、flush、open/close、清空索引数据
  （`POST <index>/_delete_by_query?conflicts=proceed&q=*:*`，带强确认）、删除索引（带输入
  索引名二次确认）。

### 文档浏览与 CRUD

- Documents tab：默认 `GET <index>/_search?size=50&sort=_doc`，表格列 `_id` + `_score` +
  `_source` 摘要（JSON 截断到 2 行），按 _doc 顺序分页（`search_after`，避免深分页性能问题）。
- 行点击展开 JSON 详情（缩进+折叠，纯 `<pre>` 高亮，不引第三方库）。
- 顶部分页控件：size 选择（20/50/100/200，上限 200），"下一页/上一页"；总 hits 数显示。
- **新建文档**：弹 JSON 编辑器（_id 可空=ES 自动生成），POST/PUT 保存。
- **编辑文档**：加载 `_source` → 修改 JSON → PUT 保存（带版本冲突检测，若 `_seq_no` 冲突则提示）。
- **删除文档**：行菜单/批量勾选 → 二次确认后 DELETE。
- 大文档提示：_source > 64KB 默认折叠。
- 支持按 _id 查询跳转。

### Mapping / Settings / Aliases 只读

- Mapping tab：`GET <index>/_mapping` 返回 JSON 树形折叠展示（字段名/type/analyzer/fields 等嵌套
  属性可折叠），支持按字段名搜索。
- Settings tab：`GET <index>/_settings` 展示索引 settings（分片/副本/分析器等），按层级折叠。
- Aliases tab：`GET <index>/_alias` 展示别名列表，可新增/删除别名（弹窗输入 alias 名，POST `/_aliases`
  actions）。
- 三个 tab v1 不提供映射/设置的**编辑**（避免误改）；只读展示为主，aliases 增删是唯一写操作
  （带确认）。映射/settings 修改走 REST 控制台手写 JSON。

### DSL 查询控制台

- DSL tab：method 固定 POST（可切 GET），path 默认 `<index>/_search`，body 区域给 JSON 模板
  `{"query":{"match_all":{}},"size":50}`。
- 执行后显示：`took/timed_out/total.value/shards.failed` 指标 + hits 表格（`_id/_score/_source`，
  与 Documents 共用表格组件）+ 原始 JSON tab。
- JSON 语法校验在发送前做（纯 JSON.parse 校验，错误行内提示）。
- 查询历史（本会话），保存常用查询（复用现有 SavedQuery 存储，后续 P2 增量再接入同步）。
- 支持聚合：响应里的 aggregations 字段以表格形式展示桶+指标；terms/date_histogram/range/sum/
  avg/min/max/cardinality 直接显示（条形图 v1 不做，纯表格）。

### REST 控制台

- Console tab：method 下拉（GET/POST/PUT/DELETE/HEAD/PATCH），path 输入框（带索引路径前缀提示），
  body JSON 区，Send 按钮。
- 响应：状态码（颜色标 2xx/4xx/5xx）、响应头、JSON/文本 body（自动格式化 JSON、缩进 2 格、
  大响应截断提示"响应超过 1MB，已截断，可点击下载完整 JSON"）。
- 命令补全：常用 ES API 路径前缀（_cat, _cluster, _nodes, _search, _mapping, _aliases, _settings,
  _bulk, _reindex 等）补全，不做完整路径智能提示。
- 请求历史（会话内），每条记录 method/path/status/took/time。
- 只读模式：GET/HEAD 放行；PUT/POST/DELETE/PATCH 默认弹"只读模式"拦截，危险方法按钮灰掉，
  但允许用户临时"以当前操作解锁"（明确确认单条写请求）。
- 危险操作确认：`DELETE /*`、`DELETE _all`、`PUT/_cluster/settings`、`DELETE <index>`、
  `POST <index>/_delete_by_query` match_all、`PUT/_template/*`、`/_security/*` 弹强确认。

### 快照/模板/ILM/Security（仅在 REST 控制台可手工调用）

本阶段**不做**专用 UI，用户通过 REST 控制台即可操作（REST 控制台本身就能发任意请求）。
后续扩展章节列出这些未来的专用 UI。

### 审计与命令日志

- 所有 REST 写操作（PUT/POST/DELETE/PATCH，除 _search/_count/_cat/_cluster/health 等读）记
  AuditLogger，方法/path/连接名/时间/took。
- REST 控制台命令日志面板，可搜索/清空。
- 危险操作单独标红。

### 快捷键与体验

- Ctrl+Enter 执行 DSL/REST 请求；Ctrl+R 刷新索引；Ctrl+N 新建连接；Ctrl+G 打开命令日志。
- 深/浅色主题跟随 VS Code，字体等宽；大小响应显示。
- 多连接可同时打开多个 ES 面板，互不阻塞。
- ES 返回错误时展示 `error.type/reason/root_cause` 结构化展示，不只打印 JSON 文本。

## 三、为什么值得做

- ES 是后端搜索/日志/分析场景的标配工具；Kibana 重、Postman 调 ES 繁琐，轻量专用 GUI 是刚需。
- P7 已经铺好 EngineKind 接缝，加 ES 是验证接缝可扩展性的第二个用例。
- ES 天然 HTTP/JSON，Node 内置 https 模块就能做客户端，零新依赖、易维护。
- REST 控制台兜底可以覆盖任何没做专用 UI 的 API，避免"功能缺一块就用不了"的尴尬。

## 四、怎么用（走一遍）

1. 新建连接，选 Elasticsearch，填 http://localhost:9200，点「测试连接」看到版本号与集群名，保存。
2. 侧栏展开 ES 连接 → 看到「集群」信息节点与「索引」类别。
3. 点连接默认打开集群总览 tab：health 绿、节点数、文档数一目了然。
4. 展开「索引」类别看到索引列表；点一个索引进详情 tab，概览/mapping/settings/aliases/docs/DSL/Console。
5. 在 Documents tab 翻页看文档；点「新建」弹 JSON 编辑器写文档保存。
6. 在 DSL tab 贴一段 query 发送，看 hits 与 aggregations。
7. 在 REST 控制台发 `GET _cat/indices?v`、`POST my-index/_search` 等任意请求。

装好扩展就能用，不需要登录。

## 五、关键决策（评审可推翻）

| # | 决策 | 理由 |
|---|---|---|
| D1 | HTTP 客户端用 **Node 内置 `https`/`http` 模块**，零新第三方依赖；CA/client cert 用 `https.Agent` | es-client 用 `axios` + 可注入 adapter（Tauri 构建走 `@tauri-apps/plugin-http` 绕 CORS），双方都**未用** `@elastic/elasticsearch`；DevBelt 在 extension host 用内置模块更彻底（无 CORS、零依赖） |
| D2 | 引擎抽象复用 P7 的 EngineKind + ConnectionSession 联合；ES 扩为 `kind:'elasticsearch'` 分支 | 接缝复用，不重复造 |
| D3 | 认证三选一：None / Basic / API Key；其他认证（Bearer token、Kerberos、AWS SigV4）v1 不做 | 三选一是 **DevBelt 的抽象**；es-client（`abs/ElasticsearchClientHttp.ts`）实为 Basic/自定义 header/Cookie，无 API Key 概念（其 `request()` 的 else 分支还会在自定义 header 时误加 Basic）。保留 DevBelt 更清晰的显式模型，不照搬上游 |
| D4 | 文档分页用 `search_after`（sort _id+_doc），不用 `from+size` 深翻 | from+size 深分页 ES 会内存爆炸；search_after 稳定 |
| D5 | 文档/索引操作只做"常用可安全回退"的集：CRUD 文档、增删 aliases；mapping/settings 编辑走 REST 控制台 | 避免误改 mapping 导致数据不可回退 |
| D6 | Webview CSP 不开放 connect-src；所有 HTTP 请求走 extension host | 安全边界保持一致 |
| D7 | API Key、password 走 SecretStorage；CA/cert/key 路径落 Memento | 对齐 SQL/Redis 凭据模型 |
| D8 | 只读模式在 EsClient request 层拦截（method 白名单 GET/HEAD + 读路径前缀白名单），与 Redis 在 sendCommand 切面拦截同样的强度 | 漏 UI 判断也不会写出 |
| D9 | 危险操作确认：DELETE /*、DELETE _all、DELETE <index>、/_cluster/settings、match_all 删文档、/_security/* | 对齐 SQL/Redis 的 confirm 强度 |
| D10 | 本阶段不接个人同步/权益（与 SQLite/Redis 一致）；ES 连接本地直连不设引擎门禁 | 同步 codec 改面大，和 ES 功能解耦 |
| D11 | JSON 展示用 `<pre>`+缩进+简易语法着色；不引 monaco/highlight.js | es-client 用 Monaco + highlight.js，REST 控制台是 Monaco 版 HTTP 文件编辑器（`src/components/RestClientEditor/*`）；本阶段**有意简化为 method+path+body 表单**以控体积，后续可增量升级 |
| D12 | Mapping/settings/aliases 展示为折叠 JSON 树（自研简易折叠组件），不引第三方 JSON viewer | 复用 Redis JSON viewer 组件的折叠能力 |

## 六、技术设计

### 6.1 引擎接缝扩 ES（复用 P7 落在 vscode-ext 的判别联合）

P7 已经把 `ConnectionSession` 拆到 `apps/vscode-ext/src/connection/connectionSession.ts` 并做成判别
联合（SqlConnectionSession | RedisConnectionSession），本阶段在同一文件扩第三种：

- `connectionSession.ts` 加 `ElasticsearchConnectionSession`：
  ```ts
  export interface ElasticsearchConnectionSession {
    kind: 'elasticsearch';
    capabilities: EsCapabilities;
    es: import('@devbelt/db-core').EsClient;
    connId: string;
    isAlive: () => boolean;
    close: () => void;
  }
  export type ConnectionSession = SqlConnectionSession | RedisConnectionSession | ElasticsearchConnectionSession;
  export type EngineKind = ConnectionSession['kind']; // 'sql' | 'redis' | 'elasticsearch'
  ```
- `DatabaseType`（`packages/db-core/src/types/connection.ts`）扩 `ELASTICSEARCH = 'ELASTICSEARCH'`。
- ES 专用字段**不**扩进 db-core 的 SQL 形态 `ConnectionConfig`，而是加到
  `packages/db-host/src/connection/connectionStore.ts` 的 `SavedConnection` 上（可选字段，P7 已为 Redis
  打开这个口子）：
  - `esProtocol?: 'http' | 'https'`（默认 `http`）；
  - `esPathPrefix?: string`（反代路径前缀）；
  - `esAuth?: { kind: 'none' } | { kind: 'basic'; username: string } | { kind: 'apiKey' }`；
    password/apiKey 走 SENSITIVE_FIELDS + SecretStorage（与 SQL password 同模式），不落 SavedConnection
    持久化对象；
  - TLS 复用 SQL/Redis 共用的 `caPath/clientCertPath/clientKeyPath/rejectUnauthorized` 字段名，连接
    表单根据引擎切换显示。

### 6.2 ES 客户端

新增 `packages/db-core/src/elasticsearch/`（纯 Node、零 vscode 依赖；与 `redis/` 和 SQL connection
adapters 并列；**不新增第三方依赖**——HTTP 客户端用 Node 内置 `http`/`https`/`tls` 模块；不加
`@elastic/elasticsearch` 官方 SDK）：

- `esClient.ts`：封装 ES REST。
  - 构造：根据 protocol + host + port + pathPrefix + auth + tls 构造 `https.Agent`/`http.Agent`；
    Basic 设 `Authorization: Basic <b64(user:pass)>`，ApiKey 设 `Authorization: ApiKey <b64idkey>`（若用户输入
    的是原始 apiKey 字符串而非 id:key 组合则直接 `ApiKey <raw>`）；CA/cert/key 通过
    `tls.createSecureContext` 加载。构造时不主动发请求；`ping()` 发 GET / 探活。
  - 统一 `request(method, path, body?, query?, options?)` 方法：
    - path 拼 pathPrefix；query 以 `?k=v` 拼接并 URL 编码；
    - body 为 JS 对象时 `JSON.stringify`，设 `Content-Type: application/json`；
    - 返回 `Promise<{status, headers, body, tookMs}>}`；4xx/5xx 不抛错，返回 body 给 UI 展示结构化错误
      （`error.type/reason/root_cause`）；
    - timeout 默认 30s；支持 `AbortSignal`（用于面板关闭时 abort in-flight 请求）。
  - 高层方法：`ping()`（GET /）、`clusterInfo()`（GET /）、`clusterHealth()`（GET _cluster/health）、
    `clusterStats()`（GET _cluster/stats）、`catNodes()`（GET _cat/nodes?format=json&h=...）、
    `catIndices()`（GET _cat/indices?format=json&h=...）、`getIndex(name)`、`getMapping(name)`、
    `getSettings(name)`、`getAliases(index)`、`updateAliases(actions)`、
    `search(index, {size, search_after, sort, body})`、`getDocument(index, id)`、
    `indexDocument(index, id?, body)`、`deleteDocument(index, id)`、`bulkDelete(index, ids)`、
    `deleteIndex(index)`、`openIndex/closeIndex/refreshIndex/flushIndex/forceMerge(index)`、
    `deleteByQueryMatchAll(index)`。
  - **只读拦截切面**：包装内部 request 方法，如果连接 `readOnly: true` 且 method 不在
    `['GET','HEAD']` 且 path 不在读路径白名单（/_search,/_count,/_cat,/_cluster/health,/_cluster/stats,
    /_nodes,/_mapping,/_settings,/_aliases,/_resolve/index,/_mget,/_msearch,/_resolve/cluster 等前缀）
    则直接返回 `{status:403, body:{error:{type:'forbidden',reason:'只读模式'}}}`，不发请求。
    允许主机侧通过 `force?: true` 选项单条解锁（UI 先弹 confirm 再 force=true 调用，对齐 Redis
    控制台"单条解锁"模式）。
  - **请求日志事件**：每次 request 完成后 emit `requestLog` 事件（method/path/status/tookMs/time/error?）。
- `esCapabilities.ts`：ES 能力声明（cluster/indices/docs/CRUD/DSL/rest/aliases/readOnly/SSH/TLS）。
- `esDangerous.ts`：危险操作判定（`DELETE /` 或 `/*`、`DELETE _all`、`DELETE <index>`、
  `PUT /_cluster/settings`、`POST <index>/_delete_by_query` 带 match_all、`PUT /_security/*`、
  `PUT /_snapshot/*`、`PUT /_template/*`）。
- `esError.ts`：把 ES 错误 body 解析成结构化 `{type, reason, rootCause}`，供 UI 友好展示。

SSH 隧道复用 vscode-ext 层现有 `SshTunnel.create(conn)`（返回 localPort，与 SQL/Redis 一致），
ES 不单独建隧道管理模块——buildSession 先拿 localPort，再把 host/port 传进 EsClient 构造。
close 走现有 `SshTunnel.close(connId)`。

不使用官方 `@elastic/elasticsearch` JS 客户端——Node 内置模块即可覆盖 v1 全部能力，且避免版本
兼容矩阵（ES 7/8 安全默认差异由 UI 层在连接表单提示即可）。

### 6.3 ConnectionManager / Tree

- `ConnectionFactory.create` 继续只服务 SQL（保持不变）；Redis 与 ES 都不进 ConnectionFactory。
- `ConnectionManager.buildSession` 加 ES 分支（与 SQL/Redis 并列）：先 `SshTunnel.create(effective)`
  拿 localPort（若配 SSH），再 `new EsClient({...})` 构造、`ping()` 探活，包成
  `ElasticsearchConnectionSession`（kind:'elasticsearch'），跳过所有 SQL 探针和服务构造；失败时
  由 doConnect 统一关闭 SSH 隧道（复用现有 tunnelOpened 清理）。
- 管理器 retain/release/disposeConn/getSession 方法对 kind 透明（只调 isAlive/close）；ES 面板
  走 elasticsearchView 自己的主机处理器，消费 session.es，不会误拿 SqlConnectionSession。
- Tree：ES 连接展开显示「集群信息」节点（`esClusterInfo.ELASTICSEARCH`，kind 扩
  `EsClusterInfo = 'esClusterInfo'`）+「索引」类别节点（`category_index.ELASTICSEARCH`，CategoryType
  扩 `'index'`）；展开索引类别显示索引节点（`esIndex.ELASTICSEARCH`，NodeKind 扩
  `EsIndex = 'esIndex'`）。
- 不展开 shards/docs（数量太大）；点索引/集群信息节点打开 ES 面板。
- DialectRegistry/QueryService 调用点都在 SQL 路径里，ES 分支不经过；TS 通过 kind 收窄兜底
  （`if (session.kind !== 'sql') throw`），与 P7 Redis 一致。
- 菜单 when：收紧所有 SQL 宽匹配，显式写 `(MYSQL|PG|SQLITE)`，防止 SQL 命令误出现在 ES/Redis
  节点；新增 ES 专属 when 子句（打开 ES 面板/REST 控制台/节点列表/断开/编辑/克隆/删除）。

### 6.4 连接表单

- `ConnectionFormView.vue`：引擎下拉加 Elasticsearch；默认端口 9200，协议 http/https 单选；认证
  方式三选一（None/Basic/ApiKey）；TLS 段（https 下显示，复用 caPath/clientCertPath/clientKeyPath/
  rejectUnauthorized 字段）；SSH 段复用现有 `sshHost/sshPort/sshUser/sshPrivateKeyPath`。
- `connectionForm.ts`：`defaultPort` 分支加 9200；`decodeConnection()` 白名单加 ES 字段
  （`esProtocol`、`esPathPrefix`、`esAuth.kind`、`esAuth.username`——password/apiKey 走独立
  `mergeSecretsFromStored` 路径，不经 decode 持久化）；test connection 走 `new EsClient(...) + ping()`，
  复用 SSH 临时建连逻辑（测试完即关隧道）。
- `packages/db-host/src/connection/connectionStore.ts`：
  - `SENSITIVE_FIELDS` 现有 `['password','sshPassword','sshPassphrase']`（P7 加了 `sentinelPassword`），
    本阶段加 `'esPassword'` 与 `'esApiKey'`；SecretStorage key 形如
    `devbelt.connection.<id>.esPassword` / `devbelt.connection.<id>.esApiKey`（沿用现有 secretKey
    命名模式）。
  - `SavedConnection` 扩可选字段：`esProtocol?; esPathPrefix?; esAuth?: { kind: 'none' } | { kind: 'basic'; username: string } | { kind: 'apiKey' };`
    TLS 字段复用 SQL/Redis 共用字段；SSH 字段复用。

### 6.5 Webview 面板（新增 `devbelt.elasticsearch`）

- 主机侧 `apps/vscode-ext/src/result/elasticsearchView.ts` 继承 BaseWebView，viewType
  `devbelt.elasticsearch`；两次 ready 握手（对齐 tableQueryView/redisView）。
- init payload 传：mode: `'elasticsearch'`（加入 protocol.ts 的 WebviewMode 联合，与
  `'redis'/'query'/'design'` 同列）、connectionId、cluster info（version/cluster_name/status）、
  索引列表首屏、readOnly 标志、初始 tab（默认 cluster）。isZh 由 BaseWebView.post 统一注入。
- 消息类型加到 `protocol.ts`（对齐 Redis/Authenticator 强类型模式），字段用 null 不用 undefined。
- webview 侧：
  - `webview/src/views/ElasticsearchView.vue` 主面板，顶栏 tab 切换：Cluster/Nodes/Indices/
    Documents/Mapping/Settings/Aliases/DSL/Console。
  - 组件拆分：`components/elasticsearch/ClusterOverview.vue`、`NodesTable.vue`、
    `IndicesTable.vue`、`DocumentTable.vue`、`DocumentEditor.vue`（JSON 编辑）、`JsonTree.vue`
    （折叠 JSON 树，复用 Redis 的 JsonTree/HexViewer 组件）、`DslConsole.vue`、`RestConsole.vue`、
    `AliasEditor.vue`、`NewIndexDialog.vue`（预留，v1 不开放）。
  - App.vue 加 `v-else-if="mode === 'elasticsearch'"` 分支；`ElasticsearchView` 用
    `defineAsyncComponent` 异步加载，单独 chunk（对齐 AuthenticatorView/RedisView 分包模式）。
- Vite 分包：`apps/vscode-ext/webview/vite.config.ts` 不新增构建入口，保持现有 `main.ts` 单入口，
  Vite 自动 code splitting 按 async chunk 拆包。
- CSP 保持 `default-src 'none'`，所有 HTTP I/O 走 extension host。

### 6.6 只读与危险确认

- 只读：EsClient request 层拦截，UI 层按钮灰 + 危险方法默认禁用；用户可临时单条解锁（弹 modal
  说明并确认）。
- 危险操作：主机侧收到请求先判断 `isDangerousRequest(method, path, body)`，是则先 post confirm
  请求，等用户确认再发。DELETE index 要求用户输入索引名确认（对齐现 SQL `dropTable` 强度）。
- 审计：写请求/危险请求走 AuditLogger。

### 6.7 i18n

- 主机侧前缀沿用现有约定：`cmd.*`（命令/通知/错误）、`conn.*`（连接相关）、`tree.*`（侧栏树）；
  新增 ES 相关词条加统一前缀 `cmd.es.*` / `conn.es.*` / `tree.es.*`。
- Webview 侧前缀沿用 `wv.*`，新增 `wv.es.*`（面板、viewer、控制台、错误、空态、按钮、快捷键提示等）。
- 严格遵守现有 i18n 机械门禁：无硬编码英文可见文案；en/zh key 集一致；占位符配对；新增 key 必须
  同时加到 catalog.en.ts 和 catalog.zh.ts。

## 七、改动文件清单（实施时）

db-core 新增/修改：

- `packages/db-core/src/types/connection.ts`（DatabaseType 扩 `ELASTICSEARCH='ELASTICSEARCH'`；
  ConnectionConfig **不**加 ES 字段）
- `packages/db-core/src/elasticsearch/esClient.ts`（新，Node 内置 https，零第三方依赖）
- `packages/db-core/src/elasticsearch/esCapabilities.ts`（新）
- `packages/db-core/src/elasticsearch/esDangerous.ts`（新）
- `packages/db-core/src/elasticsearch/esError.ts`（新）
- `packages/db-core/src/index.ts`（导出 EsClient + 相关工具函数）

vscode-ext 修改/新增：

- `apps/vscode-ext/src/connection/connectionSession.ts`（加 ElasticsearchConnectionSession 分支，
  EngineKind 联合扩 'elasticsearch'）
- `apps/vscode-ext/src/connection/connectionManager.ts`（buildSession 加 ES 分支：SshTunnel.create +
  EsClient 构造 + ping 探活）
- `apps/vscode-ext/src/connection/connectionForm.ts`（默认端口 9200、decode 白名单扩 es* 字段、
  test 分支；Basic/ApiKey 密码走独立 secret 路径）
- `apps/vscode-ext/src/connection/connectionPathValidator.ts`（复用 caPath/clientCertPath/clientKeyPath
  校验逻辑，ES 不新增路径字段）
- `apps/vscode-ext/src/tree/dbTreeDataProvider.ts`（ES 节点：esClusterInfo+category_index+esIndex）
- `apps/vscode-ext/src/tree/dbTreeNode.ts`（NodeKind 扩 EsClusterInfo/EsIndex；CategoryType 扩 'index'；
  ICON_MAP/CATEGORY_ICON 扩项）
- `apps/vscode-ext/src/result/protocol.ts`（WebviewMode 加 `'elasticsearch'`，加 ES 消息类型）
- `apps/vscode-ext/src/result/elasticsearchView.ts`（新）
- `apps/vscode-ext/src/commands/viewCommands.ts`（注册 ES 面板打开命令）
- `apps/vscode-ext/src/commands/connection.ts`（test connection 加 ES 分支；SQL server version probe
  守卫 —— ES 不走 version probe）
- `apps/vscode-ext/src/extension.ts`（注册 ES 新命令、when 子句对应命令处理器）
- `apps/vscode-ext/src/i18n/catalog.en.ts`、`catalog.zh.ts`（加 cmd.es.*/conn.es.*/tree.es.*/wv.es.*）
- `apps/vscode-ext/webview/src/App.vue`（加 `v-else-if="mode === 'elasticsearch'"` + 异步 ElasticsearchView）
- `apps/vscode-ext/webview/src/views/ElasticsearchView.vue`（新）
- `apps/vscode-ext/webview/src/components/elasticsearch/*`（新）
- `apps/vscode-ext/package.json`（新命令、菜单 when 收紧 SQL 范围为显式 MYSQL|PG|SQLITE、加 ES 图标）

db-host 最小改动：

- `packages/db-host/src/connection/connectionStore.ts`（`SENSITIVE_FIELDS` 加 `'esPassword'`/`'esApiKey'`；
  `SavedConnection` 加 ES 可选字段：`esProtocol?; esPathPrefix?; esAuth?`）。
- sync codec/applyRecords/entitlementGate：本阶段不改（本阶段不接同步）；ES 连接若被同步进 codec
  会在 `databaseEngineOf` 抛错（fail-closed），因此同步通道不会误同步 ES 连接。后续 P2 v2 增量
  切片再补 codec。

文档：

- `docs/架构.md`（实施完回填）
- `docs/产品介绍.md`、`docs/剩余任务.md`、`docs/README.md`、`docs/路线图.md`

## 八、风险与回滚

- **ES 版本兼容**：es-client 通过 `builder/v6|v7|v8` + `versionFirst` 覆盖 ES 6/7/8，并给文档 API 保留
  `type?`（低版本需传 type）。本阶段**有意收窄为 ES 7.x/8.x**，不做 ES6 的 `_type` 兼容层：连接时读取
  version 号做 UI 提示，`_type` 在 8.x 不存在时 UI 自动隐藏。
- **响应大小**：大 mapping/大搜索响应可能几十 MB，webview postMessage 有开销；默认截断 + 下载按钮。
- **深分页**：from+size 超过 10000 会被 ES 拒绝；v1 用 search_after 避免，UI 不暴露 from 直接跳转。
- **TLS 自签**：用户勾选"允许自签名"时在 Agent 里 `rejectUnauthorized:false`，UI 明确红字提示。
- **API Key 编码**：用户输入 `id:api_key` 或纯 api_key 都要支持；客户端自动 Base64 编码，编码前
  判断是否含 `:` 决定格式。
- **请求泄漏/超时**：EsClient 所有请求有 30s 超时和 AbortController；面板关闭全部 in-flight 请求
  abort，避免切面板时堆积。
- **SQL/Redis 回归**：EngineKind 接缝前两个引擎的单测/mechanical tests 必须全绿，P8 S1 不破坏。
- **回滚**：所有 ES 代码在新目录；DatabaseType.ELASTICSEARCH 与菜单命令声明是唯一侵入点，
  回滚删除即可。

## 九、交付切片（P8 内部，按顺序、每个切片可单独评审/merge/跑）

- **S1 · db-core ES 客户端 + 引擎接缝扩展（纯后端，无 UI）**
  - EngineKind/ConnectionSession 扩 'elasticsearch'；DatabaseType.ELASTICSEARCH。
  - esClient.ts 基础：request 封装 + ping/clusterInfo/clusterHealth/catIndices/search/getDocument/
    indexDocument/deleteDocument/getMapping/getSettings/getAliases + 只读拦截切面 +
    requestLog 事件 + TLS Agent + Basic/ApiKey 两种 auth。
  - esDangerous.ts 危险判定。
  - 单测：request 拼 URL/headers/auth、只读拦截、危险判定、JSON body 序列化、TLS options 构造、
    超时/abort 行为。
  - 不暴露用户 UI；SQL/Redis 现有测试全绿。
- **S2 · 扩展接线：连接表单 + 连接管理 + 集群总览 + REST 控制台最小版**
  - 表单加 ES 选项/字段（protocol/host/port/auth/TLS/SSH）；test connection 走 ping。
  - ConnectionStore 接受 ES 字段；password/apiKey 存 SecretStorage。
  - Tree 显示 ES 连接节点 + "集群"节点；右键菜单（断开/编辑/删除/克隆/控制台）。
  - ElasticsearchView webview 骨架；Cluster tab（health/version/节点数/索引数）；RestConsole
    tab（method/path/body/send/响应展示/状态码/耗时/请求历史）。
  - 只读拦截 UI（按钮灰 + 单条解锁）；危险操作 confirm modal。
  - SSH 隧道、TLS 可用。
  - i18n 基础词条；mechanical tests/commandRegistration/i18n 全绿。
  - **能跑通**：连本地 ES → 看集群信息 → REST 控制台发 GET _cat/indices、POST _search；
    只读拦截 DELETE；危险操作弹确认。
- **S3 · 索引列表 + 索引详情 + Mapping/Settings/Aliases**
  - 展开索引类别显示索引节点（cat/indices 表格、排序、搜索、health 颜色标、刷新）。
  - 点索引打开面板：概览 tab（基本统计 + open/close/refresh/flush/forcemerge/delete 操作），
    Mapping/Settings/Aliases tab（JsonTree 折叠展示，支持字段搜索）。
  - Aliases 增删（POST _aliases）。
  - 大响应截断保护。
  - **能跑通**：浏览索引列表、看 mapping/settings/aliases、加 alias、delete index 强确认。
- **S4 · 文档 CRUD + DSL 查询 + 体验增强**
  - Documents tab：search_after 分页、表格展示、展开 JSON 详情、新建/编辑/删除文档、按 _id 跳转。
  - DSL tab：JSON body 模板、语法校验、发送后 hits 表格+原始 JSON、took/timed_out/total 指标、
    aggregations 表格展示、查询历史、保存查询。
  - Nodes tab（cat/nodes 表格）。
  - 快捷键（Ctrl+Enter 执行、Ctrl+R 刷新、Ctrl+G 命令日志）、连接颜色标签、错误结构化展示
    （type/reason/root_cause）、审计日志接入、保存查询存储。
  - 手动验证矩阵：ES 7 + ES 8（无安全/Basic/ApiKey/自签 TLS/SSH）、只读模式、大索引文档翻页、
    聚合查询。

## 十、安全与隐私

- password/apiKey **只落 SecretStorage**，不落 Memento、不下发 webview、不写日志/错误栈。
- 证书/私钥路径落 Memento；文件内容由 Node 主进程读，Buffer 不传给 webview。
- Webview CSP 保持 `default-src 'none'`，所有 HTTP I/O 在 extension host 发起。
- 只读模式在 EsClient request 切面强制拦截，UI 层失效也不会发出写请求。
- 危险操作二次确认；DELETE index 要求输入索引名确认（对齐 SQL dropTable 强度）。
- 错误/日志禁止打印 Authorization 头、API Key、私钥内容。
- 允许自签名开关默认关，打开时红字安全提示。

## 十一、验证

### 自动化（必须全绿）

- `pnpm -r typecheck && pnpm -r lint && pnpm -r test`。
- db-core：EsClient URL/auth/TLS/只读/危险判定/JSON 序列化/超时 abort 单测。
- vscode-ext：commandRegistration 补 ES 命令；mechanicalGates 补"ES 节点不暴露 SQL/Redis 命令"
  断言；i18n 键存在/中英一致/占位符；baseWebViewReload 补 elasticsearch mode；webview 组件单测
  （init/message 处理/tab 切换）。
- 连接泄漏：面板 dispose 后 EsClient 的 Agent socket 全部 destroy。

### 手工验证矩阵（实施完回填 pass/fail）

| 项 | 场景 |
|---|---|
| 连接 | ES 8 http 无认证 |
|  | ES 8 https + Basic Auth |
|  | ES 8 https + API Key |
|  | ES 8 https 自签证书（勾选允许自签名） |
|  | ES 7 http 无认证（基本兼容） |
|  | SSH 隧道连接 ES |
|  | 只读模式下 PUT/POST/DELETE 被拦截 |
| 集群 | cluster health/version 展示正确 |
|  | nodes 表格显示负载信息 |
| 索引 | 索引列表加载、排序、搜索 |
|  | health 颜色标（green/yellow/red） |
|  | open/close/refresh/flush/forcemerge 操作带确认 |
|  | DELETE index 要求输入索引名确认 |
| 详情 | mapping 折叠 JSON 树展示 |
|  | settings 折叠展示 |
|  | aliases 展示+增/删 |
| 文档 | search_after 分页稳定翻页 |
|  | 新建/编辑/删除文档；seq_no 冲突提示 |
|  | 大文档折叠 |
| DSL | match_all/match/term/range/terms/bool + aggregations |
|  | JSON 语法校验 |
|  | took/timed_out/total 指标 |
| REST | GET/POST/PUT/DELETE 任意路径；状态码着色 |
|  | 危险操作确认（DELETE /*、_cluster/settings、match_all 删） |
|  | 大响应截断+下载 |
| 工程 | pnpm typecheck/lint/test 全绿 |
|  | SQL/Redis 现有全流程零回归 |
| i18n | 中英切换完整；无硬编码英文文案 |

## 十二、测试命令

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
pnpm -C apps/vscode-ext build:webview
```

Docker 起 ES：

```bash
# ES 8（默认开启安全，单节点开发模式关闭安全）
docker run -d --name es -p 9200:9200 -e "discovery.type=single-node" -e "xpack.security.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:8.15.0
# ES 7
docker run -d --name es7 -p 9201:9200 -e "discovery.type=single-node" docker.elastic.co/elasticsearch/elasticsearch:7.17.22
```

## 十三、后续扩展（不在本阶段）

- ILM policy、Index Template、Component Template、Ingest Pipeline 专用管理 UI。
- Allocation explain（分片未分配诊断）、Index analyze（分词分析）——es-client 已有，v1 仅经 REST 控制台手工调用。
- 文档/结果导出（JSON→CSV、xlsx）与 AI 助手（es-client 的 Chat2EsService）——v1 不做。
- Reindex 向导（source→dest+query+进度）、Snapshot/Restore 管理（仓库/快照/恢复进度）。
- 专用 Aggregation 可视化（条形图、饼图、日期直方图）；SQL 访问（`_sql`）。
- Security（用户/角色/API Key CRUD）专用 UI。
- Index 创建/编辑 mapping 向导（表单化而非纯 JSON）。
- 个人同步（连接+分组+保存查询+DSL 收藏）跨设备 E2EE。
- 浏览器客户端（P9）复用 EsClient 抽象。
