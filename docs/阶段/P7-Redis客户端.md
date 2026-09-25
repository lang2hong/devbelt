# P7 — Redis 客户端

> 状态：draft v2（review 修订）。本文档先讲清楚「这个阶段要做什么、给用户什么、怎么用」，
> 技术实现放在后面，交付切片放最后供开发分拆提交。
>
> 事实校对（v1→v2）：`ConnectionSession` 原定义在 `apps/vscode-ext/src/connection/connectionManager.ts`
> （非 db-core），本阶段把它拆到新文件 `apps/vscode-ext/src/connection/connectionSession.ts` 并做成
> SqlConnectionSession | RedisConnectionSession 判别联合；db-core 保持纯 SQL 形态，Redis 驱动客户端
> （ioredis 封装）放 `packages/db-core/src/redis/`（纯 Node、零 vscode 依赖），连接会话装配仍在
> ConnectionManager.buildSession 按 dbType 分派；连接颜色标签 `color?: string` 作为所有引擎共用字段
> 加在 SavedConnection 上，SQL 侧同步显示颜色。
>
> 对齐基线：Another Redis Desktop Manager（ARDM）v1.1.1（MIT，Copyright (c) shibo）。本阶段
> **直接移植/复制** ARDM 的命令表、ioredis 配置、sendCommand 切面、SSH NAT map 与 viewer 结构（MIT
> 允许复制，需在文件头保留版权与许可声明）。仅两处 DevBelt 有意加强/修正：只读拦截在 ARDM `writeCMD`
> 基础上补 admin 写命令 denylist；修正 ARDM 将 `BITOP` 误置于 `readCMD` 的分类错误（详见 6.2/6.6）。

## 一、这个阶段要做什么

给 DevBelt 加一个 **Redis 客户端**，对齐 Another Redis Desktop Manager（ARDM）的核心体验。

你平时连 Redis，要开一个独立 GUI 工具（Another Redis Desktop Manager、RedisInsight、Medis）。
这个阶段把这件事做进 DevBelt：**连接 Redis 之后，能在 DevBelt 里直接看服务器状态、浏览键、
按类型编辑值、跑命令**。连接、分组、SSH 隧道、凭据存储、只读模式这些现成能力直接复用。

一句话：**DevBelt 从「一个 SQL 数据库插件」扩展成「多引擎开发者工具」，Redis 是第一个非 SQL 引擎。**
侧栏「个人连接」树里会多出 Redis 连接，点开 DB 进入 Redis 面板（键树 + 值编辑器 + CLI 控制台 + 状态
+ 慢日志）。

设计参考：
- [Another Redis Desktop Manager](https://github.com/qishibo/AnotherRedisDesktopManager) v1.1.1（MIT）——交互/
  命令白名单/ioredis 配置/SSH+Cluster NAT map/只读拦截切面/值 viewer 派发：**核心实现直接移植/复制**，
  保留 MIT 版权与许可声明（Copyright (c) shibo）。
- VS Code 插件内现有 SQL 客户端的连接/分组/凭据/SSH/只读/审计/i18n/mechanical tests 体系全部复用。

## 二、用户能做什么

### 连接管理

- **新建/编辑/删除/克隆/分组** Redis 连接，和现有 MySQL/PG/SQLite 连接并列在侧栏「个人连接」树里，
  支持搜索、颜色标签、连接分组、连接克隆。
- **连接字段**：名称、host、port（默认 6379）、password、ACL username（Redis ≥ 6）、默认 DB 编号
  （0–15，默认 0）、key 分隔符（默认 `:`）、只读模式开关。
- **SSL/TLS**：勾选后可配置 CA 文件、客户端证书、客户端私钥、servername（SNI）；提供「允许自签名证书」
  开关（`rejectUnauthorized:false`，默认关，开时有安全提示）。
- **SSH 隧道**：复用现有 SSH 配置（host/port/user/password/私钥/私钥口令/超时），通过 SSH 转发到 Redis，
  与 MySQL/PG 的 SSH 隧道行为一致。
- **Cluster / Sentinel**：连接表单可选择「单机 / Cluster / Sentinel」三种模式；Cluster 走 Redis Cluster
  协议自动 MOVED 重定向，Sentinel 填 master 名称与节点密码自动发现 master。SSH 下的 Cluster/Sentinel
  走多隧道 + NAT map（对齐 ARDM 的 `createClusterSSHTunnels/initNatMap`）。
- **测试连接**：表单内「测试连接」按钮，PING 成功/失败给出明确反馈；SSH 模式下也能测试。
- **凭据存储**：密码/SSH 密码/SSH 私钥口令走 VS Code SecretStorage（和 SQL 连接一致），其余非敏感配置
  （host/port/db/分隔符/证书路径等）落 globalState Memento。

### 服务器视图

- 连接打开后可进入「服务器状态」面板：`INFO` 分节展示（server / clients / memory / stats /
  replication / cpu / keyspace），按 section 折叠，key-value 表格化。
- 「慢日志」面板：`SLOWLOG GET 128` 列表，显示发生时间、耗时（μs）、命令、客户端地址。
- 连接节点右键菜单：服务器状态、慢日志、控制台、断开、编辑、克隆、删除。

### CLI 控制台

- 打开控制台后可输入任意 Redis 命令，回车执行（支持多行，Shift+Enter 换行）。
- 命令以 RESP 解析后格式化展示：字符串原样、数字右对齐、数组缩进、错误红色高亮、nil 显示为 `(nil)`。
- 命令补全：输入时按 Tab/上箭头显示候选，候选来自 Redis 命令模板表（readCMD/writeCMD/adminCMD）；
  不做服务器侧 COMMAND DOCS 拉取（v1 命令模板内置，覆盖常用命令即可）。
- 命令历史：会话内上下箭头翻历史；历史记录写入本地历史存储（对齐 SQL 查询历史）。
- 每条命令显示耗时（ms）；命令和结果计入命令日志。
- **只读模式**下写命令不发往服务器，直接返回红色错误"只读模式下不允许执行写命令"（拦截在 client 层）。
- **危险命令**：`FLUSHALL`、`FLUSHDB`、`SHUTDOWN`、`CONFIG SET/REWRITE/RESETSTAT`、`KEYS *` 弹 modal
  二次确认，显示命令名并要求输入大写命令名或点「确认执行」（对齐 SQL 现有 `confirmProductionWrite` 强度）。

### 键浏览

- 打开 DB 节点进入 Redis 面板：三栏布局——左栏键树、右上栏值编辑器、右下栏控制台（标签页可切到
  控制台/命令日志/慢日志）。
- 左栏键树通过 **SCAN 分页加载**（绝不发 `KEYS *`）：
  - 默认 `COUNT=200`，滚动到底自动加载下一批；顶部可改 count 与 match 模式（如 `foo:*`、`user:*`）。
  - 按配置的 key 分隔符（默认 `:`）折叠成文件夹节点，支持展开/折叠；文件夹节点带 key 数角标。
  - 顶部刷新按钮重新从 cursor=0 扫描。
  - 顶部搜索框：服务端 match 过滤（不在客户端做全量过滤）。
  - 多选（Shift/Ctrl）+「批量删除」按钮，弹确认显示已选 key 数。
  - 大 key 保护：值大小超过 1MB 时先显示大小提示，不自动拉取内容，点「加载」才取。
- 展开连接节点后显示 DB 节点（通过 `INFO keyspace` 枚举 0–15 中实际存在的 DB），点 DB 打开该 DB 的
  Redis 面板；面板内可切换 DB。
- 键节点右键菜单：查看/重命名/删除/TTL/复制 key 名。

### 类型查看/编辑

选中 key 后右上栏按 key 的 `TYPE` 自动切换 viewer 组件。v1 完整支持五种基础类型 + Stream：

- **string**：
  - 视图切换：文本 / JSON（自动格式化+语法高亮+校验）/ 二进制 hex / 数字。
  - 编辑区可修改值，点「保存」发 SET；追加模式（APPEND）。
  - TTL 显示剩余秒/毫秒，可修改 EXPIRE/PEXPIRE/PERSIST。
  - 二进制 hex 视图可编辑字节，保存时按 hex 编码发送。
- **hash**：
  - 表格列 field / value，支持 HSCAN 分页、排序、搜索字段。
  - 新增/修改/删除字段（HSET/HDEL），批量删除多个字段。
  - 字段值大时支持展开。
- **list**：
  - 按索引分页（LRANGE），支持左/右 push、按索引 LSET 修改、LREM 删除指定元素、
    LPOP/RPOP、LTRIM 裁剪。
  - 顶部显示 LLEN；支持索引跳转。
- **set**：
  - SSCAN 分页成员列表，SADD/SREM 增删成员；成员大时显示长度。
- **zset**：
  - 三列 member / score / 操作，默认按 score 顺序 ZRANGE 分页，可切换 REV、按 score 范围查询。
  - ZADD/ZREM/ZINCRBY；支持分页大小调整。
- **stream**（v1 基础支持）：
  - XRANGE/XREVRANGE 分页 entry（entry-id + fields 表格）；XADD 追加 entry；XDEL 按 ID 删除；
    XTRIM MAXLEN。
  - XINFO GROUPS/CONSUMERS 查看消费组与消费者；XGROUP CREATE/DESTROY/DELCONSUMER；
    XPENDING 查看待处理条目；XREADGROUP 读取（基础版：不做阻塞监听循环）。
- 顶部工具栏：重命名 key、删除 key（带确认）、TTL 设置、刷新、复制 key 名/值。

### 新建 key

- 面板左上「＋ 新建 key」按钮：弹小表单选类型（string/hash/list/set/zset/stream），输入 key、TTL、
  初值（不同类型初值表单不同：string 填文本；hash 至少一对 field-value；list 可填多个初始元素；
  set/zset 按行输入）。保存后自动刷新键树并选中新 key。

### 命令日志

- 命令日志（对齐 ARDM 的 CommandLog）：记录本次会话所有命令——时间、连接名、命令名+参数、耗时。
- 提供「命令日志」面板，可搜索/清空/复制；日志只在本地内存 + 历史文件，不上传、不同步。
- 记录点通过 ioredis 的 `sendCommand` monkey-patch 统一注入（连接层切一下，业务代码无需逐处打点，
  对齐 ARDM `redisClient.js` 的做法）；只读拦截也挂在这个切面上，保证写命令不发往服务器。

### 快捷键与体验

- Ctrl+N（⌘+N）新建连接；Ctrl+G（⌘+G）打开命令日志；Ctrl+,（⌘+,）打开设置；
  Ctrl+Enter 执行控制台命令；Del 删除选中 key（带确认）；F5 刷新键树。
- 深/浅色主题跟随 VS Code；字体跟随设置；结果区字体使用等宽。
- 多连接可同时打开多个 Redis 面板（每个 DB 一个 webview panel，和 SQL 表面板一致），互不阻塞。
- JSON 自动格式化（缩进 2 格），JSON 语法错误时红线提示不发送；错误消息展示 Redis 原始错误（含 ERR 前缀）。

## 三、为什么值得做

- Redis 是后端/运维/中间件开发的高频刚需工具；独立 GUI 工具和 VS Code 之间切换成本高。
- 复用现成的连接/分组/SSH/凭据/只读/审计/主题/i18n 体系，新增一个引擎边际成本低，同时验证
  「DevBelt 从 SQL 插件 → 多引擎开发者工具」的抽象接缝，为后续 ES（P8）、浏览器客户端（P9）铺路。
- Cluster/Sentinel/SSH 隧道 NAT map 这几块 ARDM 踩过的坑直接借鉴，避免自己造轮子重复踩。

## 四、怎么用（走一遍）

1. 命令面板执行「DevBelt: 新建连接」，引擎选 Redis，填 host/port/password，点「测试连接」看到
   绿色「连接成功」，保存。
2. 侧栏「个人连接」树出现该 Redis 连接（带 Redis 图标），展开看到 DB0 等节点。
3. 点 DB0，右侧打开 Redis 面板：左边键树（显示 SCAN 加载的前 200 个 key，按 `:` 折叠），
   右上是值查看区（还没选中 key 显示空态提示），右下是控制台标签。
4. 键树里找到一个 key 点击，右上切换对应 viewer；点控制台标签可敲 `PING`/`INFO server`/`GET foo`。
5. 顶栏「＋ 新建 key」可加新 key；右键 key 可删/重命名/改 TTL。
6. 右键连接节点可打开服务器状态、慢日志。

装好扩展就能用，本地 Redis 不需要登录账号。

## 五、关键决策（评审时可推翻）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 引擎抽象用 **EngineKind 判别器 + ConnectionSession 判别联合**，不把 Redis 伪装成 SQL 方言 | SQL 方言契约（wrap/getPagedSql/DDL）与 Redis 不兼容，伪造方言会污染所有调用方 |
| D2 | SQL 路径零行为改动，现有三引擎单测/mechanical tests 必须保持全绿 | 回归是硬门槛 |
| D3 | Redis 驱动选 **ioredis@^5**（纯 JS，无原生构建），ARDM 已验证可生产使用；cluster/sentinel/TLS/SSH NAT map 都有现成模式 | 稳定、无 native 依赖、API 友好 |
| D4 | 命令切分**直接复用 ARDM 的 splitargs**（上游用 `@qii404/redis-splitargs`，MIT）：加该依赖，或按同语义移植其逻辑，保证引号/转义行为与 ARDM 一致 | 参考项目质量高、可直接复制；自研易在引号/转义边界与上游不一致 |
| D5 | 键浏览在 webview 面板内做（SCAN 分页+分隔符折叠），不把百万 key 塞进 VS Code TreeView | TreeView 百万节点会卡死；对齐 ARDM 的浏览器内键树 |
| D6 | webview CSP **不放开 connect-src**，所有 Redis I/O 走 extension host（postMessage 桥接） | 保持现有 webview 安全边界 |
| D7 | 密码/SSH 口令走 SecretStorage；CA/证书/私钥路径落 Memento（内容由 Node 读）；私钥内容不下发 webview | 对齐 SQL 连接的凭据模型 |
| D8 | 只读拦截、命令日志、耗时统计通过 **monkey-patch ioredis.sendCommand** 单点切面注入 | 对齐 ARDM 已验证的可靠做法；避免业务层到处加判断漏拦截 |
| D9 | 危险命令名单：FLUSHALL/FLUSHDB/SHUTDOWN/CONFIG SET/REWRITE/RESETSTAT/KEYS \*，modal 二次确认 | 与现有 SQL `confirmProductionWrite` 同级别强度 |
| D10 | Cluster/Sentinel/SSH NAT map **本阶段完整交付**，不拆未来版本 | ARDM 已有可直接借鉴的实现模式，不留给用户残缺体验 |
| D11 | 命令补全用内置命令模板表（移植 ARDM readCMD/writeCMD/adminCMD），不做 COMMAND DOCS 拉取 | 命令元数据量大且版本差异多；内置模板覆盖 v1 常用命令足够 |
| D12 | 本阶段不接个人同步/权益（和 SQLite 一致：本地直连、不设引擎门禁），Redis 连接是否进入同步留给后续 P2 v2 增量切片 | 同步 codec 改面大、需要服务端种子迁移，和 Redis 客户端功能解耦 |
| D13 | 值 viewer 不引入第三方 JSON 高亮/图表库；JSON 用纯 `<pre>`+缩进+简易语法着色（复用现有 webview 样式体系）；不做 hex editor 组件以外的二进制可视化 | 控制 webview bundle 体积；后续有可视化需要再增量加 |

## 六、技术设计

### 6.1 引擎抽象接缝（vscode-ext 层判别联合）

事实校对：`ConnectionSession` 当前定义在 `apps/vscode-ext/src/connection/connectionManager.ts`（不是 db-core），
db-core 目前是纯 SQL 形态（`QueryService/MetadataService/DataService/TableService` + SQL 方言），强行把非 SQL
客户端塞进 db-core 会让 core 混入 Node 驱动并破坏现有 SQL-only 内聚。本阶段接缝落在 vscode-ext 层：

- `apps/vscode-ext/src/connection/connectionSession.ts`（新文件；把现有 connectionManager.ts 内的
  `ConnectionSession` 迁出来并扩成判别联合，connectionManager.ts 改为 import）：
  ```ts
  export interface SqlConnectionSession {
    kind: 'sql';
    capabilities: import('@devbelt/db-core').DatabaseCapabilities;
    query: import('@devbelt/db-core').QueryService;
    metadata: import('@devbelt/db-core').MetadataService;
    data: import('@devbelt/db-core').DataService;
    table: import('@devbelt/db-core').TableService;
    isAlive: () => boolean;
    close: () => void;
  }
  export interface RedisConnectionSession {
    kind: 'redis';
    capabilities: RedisCapabilities;
    redis: import('./redisClient.js').RedisClient;
    connId: string;
    isAlive: () => boolean;
    close: () => void;
  }
  export type ConnectionSession = SqlConnectionSession | RedisConnectionSession;
  export type EngineKind = ConnectionSession['kind'];
  ```
- `DatabaseType` 枚举（`packages/db-core/src/types/connection.ts`）扩 `REDIS = 'REDIS'`。
  db-core 仍然只导出 DatabaseType 字面量，不感知具体引擎客户端；SQL 路径零行为改动。
- `packages/db-core/src/types/connection.ts` 的 `ConnectionConfig` 是 SQL 形态（host/port/user/password/
  database/schema/useSSL/...），Redis 专用字段**不**扩进 ConnectionConfig，而是加到 vscode-ext 层的
  Redis 配置类型（见 6.2）并在 `packages/db-host/src/connection/connectionStore.ts` 的 `SavedConnection`
  上以可选字段追加（SavedConnection 已经做字段白名单外的宽松扩展，无 breaking change）。
- Redis 驱动客户端放在 `packages/db-core/src/redis/`（与 SQL 连接适配器并列，保持纯 Node、零 vscode
  依赖，便于未来复用），但 `ConnectionFactory` 不感知 Redis；会话装配在 `ConnectionManager.buildSession`
  按 `dbType` 分派。

### 6.2 Redis 客户端

新增 `packages/db-core/src/redis/`（纯 Node、零 vscode 依赖，与 SQL 连接适配器并列；ioredis 加为
`packages/db-core/package.json` 的 dependencies，vscode-ext/db-host 不直接依赖 ioredis）：

- `redisClient.ts`：封装 ioredis。
  - 实现口径（v3 对齐代码）：db-core 的 `RedisClient` 构造参数是纯 options（host/port/username/password/
    db/tls/connectTimeout/readOnly/onLog），**不依赖 `SavedConnection`**（db-host 类型）；`SavedConnection`→
    options 的映射放在 vscode-ext `ConnectionManager.buildRedisSession`。standalone/cluster/sentinel 的
    `getRedisOptions/getSentinelOptions/getClusterOptions` 分型构造随 S4 引入。
  - 统一配置（**原样复制 ARDM `getRedisOptions`**）：`stringNumbers: true`（避免 JS 数字精度丢失）、
    `enableReadyCheck: false`、`connectTimeout: 30000`、`family: 0`；`retryStrategy` 最多 3 次——
    `times=1→200ms`、`times=2→400ms`、`times>=3→放弃`（ARDM 为 `Math.min(times*200,1000)` +
    `maxRetryTimes=3`，1000ms 上限实际不可达）。
  - `hgetall` reply transformer 改为 `[[k,v],...]`（避免对象丢失二进制 key）。
  - **sendCommand monkey-patch**（复制 ARDM 实现）：
    1. 只读模式：命中 `writeCMD` → reject（与 ARDM 一致）；**DevBelt 加强**：额外命中 admin 写命令
       denylist（`CONFIG SET/REWRITE/RESETSTAT`、`ACL SETUSER/DELUSER/LOAD/SAVE`、`SHUTDOWN`、`DEBUG`、
       `MODULE LOAD/UNLOAD`、`REPLICAOF/SLAVEOF/FAILOVER`、`SAVE/BGSAVE/BGREWRITEAOF`、`CLIENT KILL`、
       `MONITOR`）也 reject——ARDM 只查 `writeCMD`，这些命令在上游只读模式下**不会被拦截**；
    2. 发命令、计时，完成后 emit `commandLog` 事件（time/command/cost/connectionName）；
    3. 暴露 `withoutLogging()` 一次跳过日志（给内部 PING/INFO 探活用）。
  - 高层 API：`ping/info(section?)/slowlog(count)/scan(cursor, match, count, db)/type(key)/get/set/
    del/rename/ttl/pttl/expire/persist/dbsize/select(db)/` + hash/list/set/zset/stream 族方法
    （`hgetall/hset/hdel/hscan/...`、`lrange/lpush/rpush/lset/lrem/ltrim/...`、`smembers/sadd/srem/sscan/...`、
    `zrange/zadd/zrem/zscan/...`、`xrange/xadd/xdel/xtrim/xinfoGroups/xpending/...`）。
- `redisCommands.ts`（复制 ARDM `src/commands.js`，保留 MIT 归属）：
  - 上游 `commands.js` 只导出 `allCMD`/`writeCMD`，`readCMD`/`adminCMD` 是模块内私有常量；复制时在本
    模块**分别导出三张表**，作为：① 控制台补全候选；② 只读判定（`isWriteCommand`）；③ 危险判定
    （`isDangerousCommand`：FLUSHALL/FLUSHDB/SHUTDOWN/CONFIG SET/REWRITE/RESETSTAT/KEYS 通配）。
  - **修正上游分类错误**：ARDM 把 `BITOP`（会写 `destkey`）放在 `readCMD`，复制时须移入 `writeCMD`，
    否则只读模式会放行 BITOP；单测断言 `isWriteCommand('BITOP') === true`。
  - 命令表仅做基础分类，不做文档字符串。
- `redisSplitArgs.ts`（S2 新增）：控制台命令行切分，移植 ARDM 使用的 `@qii404/redis-splitargs` v1.0.1
  （MIT）用户可见语义（空白分隔 / 双引号转义含 hex / 单引号转义 / 未闭合抛错），零第三方依赖；
  修正上游「数组 `+=` 退化为字符串」缺陷。切分在主机侧完成。
- `redisTls.ts`：读 CA/cert/key 文件，产出 ioredis `tls` 参数对象（`{ca,key,cert,servername,rejectUnauthorized}`；
  ioredis 接受 options 对象，不必显式构造 SecureContext）。**有意不复制 ARDM 的 TLS 策略**：上游
  `getTLSOptions` 硬编码 `rejectUnauthorized:false` 且 `checkServerIdentity:()=>undefined`（跳过主机名校验）；
  DevBelt 对齐 SQL 连接的安全默认——`rejectUnauthorized` 默认 true、可显式放行自签，且不跳过主机名校验。

SSH 隧道与 Cluster/Sentinel NAT map 放在 vscode-ext（`apps/vscode-ext/src/connection/redisTunnel.ts`，
新文件），因为依赖现有 `SshTunnel`（vscode-ext 层）：
- `redisTunnel.ts` 复用 `SshTunnel.create(conn)`（返回 localPort，现有 API，对齐 SQL 路径）做单节点 SSH 转发。
- **Cluster**（复制 ARDM `createClusterSSHTunnels/initNatMap`）：SSH 到入口节点 → 临时 client →
  `CLUSTER NODES`（上游 `getClusterNodes` **默认只取 `master` 节点**）→ 为每个 master 建 SSH 隧道 →
  `{ 'dstHost:dstPort': { host: localHost, port: localPort } }` natMap → `new Redis.Cluster([...], {natMap})`。
- **Sentinel**（与 Cluster 不同，上游无 natMap）：SSH 到入口 → 临时 client →
  `SENTINEL get-master-addr-by-name <masterName>` 发现 master → 为 master 建隧道 → 以 `forceStandalone`
  方式连 master（`removeDb`，因 sentinel 模式无 SELECT）。
- 连接 close 时通过现有 `SshTunnel.close(connId)` 回收全部隧道（复用 ConnectionManager.close 现有逻辑）。

- `redisCapabilities.ts`（放 vscode-ext 侧 `connection/redisCapabilities.ts`，与 `DatabaseCapabilities`
  同层概念但不共享接口，因为 Redis 的能力面与 SQL 完全不同）：Redis 能力声明（v1 全部 true：
  standalone/cluster/sentinel/TLS/SSH/readonly/CLI/key browser/five types/stream/info/slowlog/command log）。

### 6.3 ConnectionManager / Factory / Tree

- `ConnectionFactory.create` 继续只服务 SQL（保持 `packages/db-core/src/factory/connectionFactory.ts` 不变）；
  Redis 连接由 `RedisClient.createConnection`（db-core）+ `redisTunnel.ts`（vscode-ext）在
  `ConnectionManager.buildSession` 内按 `conn.dbType` 分派。
- `ConnectionManager.buildSession` 分支：
  - SQL：原路径不变（含 `@@sql_mode` / `standard_conforming_strings` 探针、构造 QueryService 等），
    最终包成 `SqlConnectionSession`（kind:'sql'）。
  - Redis：先 `SshTunnel.create(effective)` 拿到 localPort（若配 SSH），再 `RedisClient.createConnection`
    构造 ioredis 实例、等 `ready`、包成 `RedisConnectionSession`（kind:'redis'）；**跳过**所有 SQL
    探针与 SQL 服务构造；探活用 `redis.ping()`/`redis.info('keyspace')`，失败抛错并由 doConnect
    统一关闭 SSH 隧道（复用现有 `tunnelOpened` 清理路径）。
- 管理器其它方法（retain/release/disposeConn/getSession/evict）对 kind 透明——它们只持有
  `ConnectionSession` 联合并调用 `isAlive/close`，无需类型分支。所有调用 `session.query.*` 的
  消费点（QueryRunner/RowEditor/ExportHandler/tableDesignView 等）必须先判 `session.kind==='sql'`；
  Redis 面板走自己的 redisView 主机处理器，不会拿到 SqlConnectionSession 以外的会话。
- `DbTreeDataProvider`：
  - 展开 Redis 连接 → 显示「服务器信息」+「DB」类别节点；DB 节点从 `INFO keyspace` 取（缺省只
    显示 db0）。不继续展开键（键在 webview 内分页加载，避免阻塞树）。
  - 所有 `DialectRegistry.get(conn.dbType, ...)` 调用点（目前都在 SQL 路径里：buildSession SQL
    分支、QueryService 构造后）天然不会命中 Redis 连接，因为 Redis 分支根本不经过这里；**不**
    需要给每个调用点加守卫，但机械测试要加断言：Redis 会话上不允许调用 DialectRegistry/QueryService。
- `DbTreeNode`（`apps/vscode-ext/src/tree/dbTreeNode.ts`）：
  - `NodeKind` 扩 `RedisDb = 'redisDb'` 与 `RedisServerInfo = 'redisServerInfo'`；
    `CategoryType` 不需要扩（Redis 没有 SQL 那种 table/view/function 分类）。
  - `contextValue` 沿用 `` `${base}.${dbType}` `` 格式；新增 Redis 节点 base：
    `connectionOpen.REDIS`、`connectionClosed.REDIS`、`redisDb.REDIS`、`redisServerInfo.REDIS`。
- 菜单 `when`：所有 SQL 宽匹配（如 `/^table\./`、`/^database\.(MYSQL|PG)$/`、
  `/^connectionOpen\.(MYSQL|PG)$/`）**必须**显式写数据库类型范围（MYSQL|PG|SQLITE），不能用
  `/^connectionOpen\./` 这种宽匹配，否则会误命中 Redis 连接。审查现有 package.json 菜单
  when，把所有能落到 connection 节点上的 SQL 命令改为显式列举 `(MYSQL|PG|SQLITE)`。
  新增 Redis 节点专属 when 子句（打开 Redis 面板、断开、编辑、删除、克隆）。机械测试补断言：
  Redis 节点上不出现 SQL 专属命令。

### 6.4 连接表单

- `ConnectionFormView.vue`：引擎下拉加 Redis；选 Redis 时端口默认 6379；显示 Redis 专用字段
  （ACL username 复用现有 `user` 字段、默认 DB、key 分隔符、模式 standalone/cluster/sentinel、
  sentinel master、sentinel 密码、TLS 开关与证书选择、SSH 段复用现有；`password` 字段复用为 Redis
  密码 / ACL 密码）。
- `connectionForm.ts`：`defaultPort` 分支加 6379；`decodeConnection()` 白名单加 Redis 字段
  （`redisDb`、`keySeparator`、`redisMode`、`sentinelName`、`sentinelPassword`、TLS 路径字段
  复用现有 `caPath/clientCertPath/clientKeyPath/rejectUnauthorized`——Redis 与 SQL 共用同一组
  TLS 字段名，连接表单根据引擎切换显示）；test connection 分支：Redis 走临时
  `RedisClient.createConnection + ping`（复用 SshTunnel 临时建连逻辑，测试完即关）。
- `packages/db-host/src/connection/connectionStore.ts`：
  - `SENSITIVE_FIELDS` 现有 `['password', 'sshPassword', 'sshPassphrase']` 已覆盖 Redis 密码 / SSH 密码；
    新增 `sentinelPassword`（sentinel 节点密码敏感）。
  - `SavedConnection` 扩可选字段：`redisDb?: number; keySeparator?: string; redisMode?: 'standalone' | 'cluster' | 'sentinel'; sentinelName?: string; sentinelPassword?: string; color?: string;`
    （`color?: string` 是连接颜色标签，所有引擎共用，SQL 侧同步显示）。
  - 证书/私钥路径复用现有字段，不敏感，落 memento。

### 6.5 Webview 面板（新增 `devbelt.redis`）

- 主机侧 `apps/vscode-ext/src/result/redisView.ts`：
  - 继承 `BaseWebView`，viewType `devbelt.redis`。
  - 两次 ready 握手：第 1 次 ready → `post({type:'init', mode:'redis', ...initPayload})`（传
    connectionId/db、keySeparator、readOnly、initialKeys 首批、dbsize、info、isCluster/isSentinel）；
    第 2 次 ready 后按需响应键扫描/值读取/命令执行/CRUD 请求。
  - 所有 Redis I/O 走 session.redis，结果 post 回 webview。
  - 面板打开时 retain 连接、关闭时 release；dispose 时关闭订阅/MONITOR 等附加 client。
- 协议消息类型加到 `protocol.ts`（对齐 authenticator 强类型模式），所有字段用 `null` 不用 `undefined`。
- webview 侧：
  - `webview/src/views/RedisView.vue` 主面板，三栏布局（KeyTree/ValueViewer/Console 标签区）。
  - 组件拆分：`components/redis/KeyTree.vue`、`ValueViewer.vue`（type 派发）、`viewers/StringViewer.vue`、
    `HashViewer.vue`、`ListViewer.vue`、`SetViewer.vue`、`ZsetViewer.vue`、`StreamViewer.vue`、
    `CliConsole.vue`、`ServerStatus.vue`、`SlowLog.vue`、`CommandLog.vue`、`KeyNewDialog.vue`、
    `HexEditor.vue`（简易 hex 表格：offset/hex/ascii）。
  - App.vue 加 `v-else-if="mode === 'redis'"` 分支；异步 `defineAsyncComponent` 单独 chunk 打包
    （对齐 AuthenticatorView 的分包模式，避免影响 SQL webview 首屏体积）。
- Vite 分包：`apps/vscode-ext/webview/vite.config.ts` 现有配置为单入口 `main.ts` + 自动 code
  splitting（`defineAsyncComponent` 会被 Vite 自动拆成独立 chunk，与 AuthenticatorView 模式一致），
  **不新增构建入口**、不改 rollupOptions。所有面板走现有共享 Vite 构建。
- CSP 保持现有 `default-src 'none'`，不开放 connect-src/img-src/worker-src；所有 Redis I/O 通过
  extension host 桥接。

### 6.6 只读与危险命令

- 只读拦截：在 RedisClient sendCommand 切面里判断 `isWriteCommand(name.toUpperCase())`，
  只读模式下直接 reject，不发包。`isWriteCommand` = ARDM `writeCMD` 命中 **或** admin 写命令 denylist
  命中（见 6.2，DevBelt 相对 ARDM 的加强）。
- 危险命令确认：主机侧在执行命令前判断 `isDangerousCommand(name.toUpperCase())`，若面板/命令来自
  控制台则通过 webview post 一个 confirm 请求，等用户确认再发；不弹 VS Code modal（避免中断
  webview 操作流），在 webview 内出 modal 组件（对齐现有 `confirmSqlExecution` 强度）。
- 审计日志：写命令、危险命令、批量删除走 `AuditLogger`（对齐 SQL 审计）。

### 6.7 i18n

- 新增词条：
  - 主机侧 `cmd.redis.*`（连接、状态、慢日志、控制台、新建 key、删除/重命名/TTL、danger 确认等）。
  - Webview 侧 `wv.redis.*`（面板、viewer、控制台、错误、空态、按钮、快捷键提示等）。
- 严格遵守现有 i18n 机械门禁：无硬编码英文可见文案；en/zh key 集一致；占位符配对。

## 七、改动文件清单（实施时）

db-core 新增/修改：

- `packages/db-core/src/types/connection.ts`（DatabaseType 扩 `REDIS='REDIS'`；ConnectionConfig **不**
  加 Redis 字段——Redis 专用字段落在 SavedConnection 上）
- `packages/db-core/src/redis/redisClient.ts`（新）
- `packages/db-core/src/redis/redisCommands.ts`（新）
- `packages/db-core/src/redis/redisTls.ts`（新）
- `packages/db-core/src/redis/redisSplitArgs.ts`（新，S2）
- `packages/db-core/src/index.ts`（导出 RedisClient、redisCommands 读写/危险判定工具）
- `packages/db-core/package.json`（新增 `ioredis@^5` 依赖）
- `packages/db-core/src/factory/connectionFactory.ts`（**不改**，仅 SQL）

vscode-ext 修改/新增：

- `apps/vscode-ext/src/connection/connectionSession.ts`（新：SqlConnectionSession / RedisConnectionSession
  判别联合 + EngineKind 类型；从 connectionManager.ts 迁出现有 ConnectionSession 并加 kind 字段）
- `apps/vscode-ext/src/connection/connectionManager.ts`（删除内嵌 ConnectionSession，改为 import
  connectionSession.ts；buildSession 按 dbType 分派 Redis 分支；close 复用 SshTunnel.close）
- `apps/vscode-ext/src/connection/redisTunnel.ts`（新：Cluster/Sentinel 多节点 SSH NAT map 构造）
- `apps/vscode-ext/src/connection/redisCapabilities.ts`（新）
- `apps/vscode-ext/src/connection/connectionForm.ts`（默认端口 6379、decode 白名单扩 Redis 字段、test 分支）
- `apps/vscode-ext/src/connection/connectionPathValidator.ts`（字段校验：复用 caPath/clientCertPath/
  clientKeyPath 校验，Redis 不新增路径字段）
- `apps/vscode-ext/src/tree/dbTreeDataProvider.ts`（Redis 连接节点展开：serverInfo+DB 类别+redisDb 节点）
- `apps/vscode-ext/src/tree/dbTreeNode.ts`（NodeKind 扩 RedisDb/RedisServerInfo、ICON_MAP/CATEGORY_ICON 扩项）
- `apps/vscode-ext/src/result/protocol.ts`（WebviewMode 加 `'redis'`，加 Redis 消息类型）
- `apps/vscode-ext/src/result/redisView.ts`（新）
- `apps/vscode-ext/src/commands/viewCommands.ts`（注册 Redis 面板打开命令）
- `apps/vscode-ext/src/commands/connection.ts`（test connection 分支、server version probe SQL 守卫
  —— Redis 不走 version probe）
- `apps/vscode-ext/src/extension.ts`（注册新命令、Redis when 子句对应命令处理器；现有 SQL 命令注册逻辑
  不动）
- `apps/vscode-ext/src/terminal/terminalService.ts`（不加；Redis 控制台走 webview CLI，不启外部终端）
- `apps/vscode-ext/src/utils/sqlSafety.ts`（不改；Redis 走自己的 sendCommand 切面只读拦截）
- `apps/vscode-ext/src/i18n/catalog.en.ts`、`catalog.zh.ts`（加 cmd.redis.* 与 wv.redis.*）
- `apps/vscode-ext/webview/src/App.vue`（加 `v-else-if="mode === 'redis'"` + 异步 RedisView）
- `apps/vscode-ext/webview/src/views/RedisView.vue`（新）
- `apps/vscode-ext/webview/src/components/redis/*`（新，多个 viewer/console 组件）
- `apps/vscode-ext/package.json`（新命令、菜单 when 收紧 SQL 范围为显式 MYSQL|PG|SQLITE、加 Redis 图标）

db-host 最小改动：

- `packages/db-host/src/connection/connectionStore.ts`（`SENSITIVE_FIELDS` 加 `sentinelPassword`；
  `SavedConnection` 加 Redis 可选字段 + `color?: string` 连接颜色标签，所有引擎共用）。
- `packages/db-host/src/sync/entitlementGate.ts`（不改——本阶段不接权益/同步，`databaseEngineOf`
  仅在同步入站路径调用，本地直连不触发）。
- sync codec/applyRecords：本阶段不改，Redis 连接先本地直连；连接若被同步进 codec 会在
  `databaseEngineOf` 抛错（fail-closed），因此同步通道不会误同步 Redis 连接。后续 P2 v2 增量
  切片再补 codec。

文档：

- `docs/架构.md`（实施完回填事实）
- `docs/产品介绍.md`（加 Redis 到引擎列表，完成后回填）
- `docs/剩余任务.md`（加 P7 台账区）
- `docs/README.md`、`docs/路线图.md`（登记 P7）

## 八、风险与回滚

- **SQL 路径回归**：引擎抽象若有任何未覆盖的 DialectRegistry 调用点，会导致 SQL 连接失败；
  S1 必须跑通全部现有 SQL 单测/mechanical tests/commandRegistration/i18n 门禁，任何一个不绿
  不进 S2。
- **ioredis 与 SSH cluster NAT map 坑**：ARDM 已经验证的 natMap 模式可直接借鉴，但 cluster
  slots refresh、节点变更、故障切换需要真实 Redis Cluster 环境验证（S3 用 Docker 起 3 节点）。
- **大 DB SCAN 性能**：百万级 key 场景 count 与折叠算法需实测；S3 验收包含 10w/50w key 性能基准。
- **二进制值**：hash/list/set/zset 里的二进制 value 不能直接 toString；通过 redisClient 统一用
  Buffer 返回，hex viewer 渲染，编辑按 hex 写回（明确 v1 不做 msgpack/protobuf 等自动解码）。
- **连接状态与内存泄漏**：RedisCluster/Sentinel 会持有多个节点连接；close 必须全部 quit，面板
  dispose 必须释放 retain 计数；S1/S2 加连接泄漏检测单测。
- **命令白名单完整性**：Redis 新命令（Redis 7.4+ 的 hash field TTL、RedisJSON、TS 等）不在
  v1 命令表；控制台仍可执行（只在补全/只读判定处缺，执行本身不受限），不影响功能。
- **上游基线漂移**：本设计对齐 ARDM v1.1.1（MIT）。复制其命令表/实现时保留版权与许可声明；上游
  升级可能新增命令或调整分类，需定期对照（命令表分类单测作为回归护栏）。
- **CSP**：不开放 connect-src，所有网络 I/O 经 extension host；如果 viewer 误发 fetch 将被 CSP
  阻止，安全边界保持。
- **回滚**：所有 Redis 代码在新目录/新分支，SQL 路径零改动；如要回滚，删除 `DatabaseType.REDIS`
  + Redis 目录 + package.json 命令/菜单声明即可，不影响 SQL 链路。

## 九、交付切片（P7 内部，按顺序、每个切片可单独评审/merge/跑）

> 每个切片合入后现有 SQL 三引擎功能必须保持可用、所有机械测试全绿。切片不跨 commit 堆叠半成品 UI。

- **S1 · 引擎抽象接缝 + db-core Redis 客户端（纯后端，无 UI）**
  - 把 `ConnectionSession` 从 `connectionManager.ts` 拆到新文件 `connectionSession.ts`，加 `kind`
    判别字段，扩 `RedisConnectionSession`；`buildSession` SQL 分支包成 `SqlConnectionSession`；
    Redis 分支骨架（返回 not-yet-implemented，S2 再接真连接）。
  - 所有消费 `session.query.*` 的主机侧调用点（QueryRunner/RowEditor/ExportHandler/tableDesignView/
    tableQueryView 等）天然只出现在 SQL 面板路径里——通过 TS 类型收窄（`if (session.kind !== 'sql') throw`）
    加一道兜底即可，不需要大面积改业务代码；Redis 面板走自己的 redisView 处理器，只拿
    RedisConnectionSession。
  - `DatabaseType.REDIS` 加入枚举；SavedConnection 加 Redis 可选字段。
  - 新增 `redisClient.ts`/`redisCommands.ts`/`redisTls.ts`（standalone + ping/info/quit + sendCommand
    切面 + 只读拦截 + 命令日志事件）。
  - 单测：命令白名单读写分类、只读拦截、scan/get/set/del/ttl、TLS options 构造；**现有 SQL 三引擎
    全部单测零回归**（`packages/db-core/test` + `apps/vscode-ext/test`）。
  - 不暴露任何用户可见 UI；只在 db-core 就绪客户端能力。
- **S2 · 扩展接线：连接表单 + 连接管理 + 服务器状态/控制台 webview 最小版**
  - 连接表单加 Redis 选项/字段；默认端口/decode/test connection 走 RedisClient.ping。
  - ConnectionStore 接受 Redis 字段；敏感字段存 SecretStorage。
  - Tree 显示 Redis 连接节点（先不展开 DB），右键菜单有「断开/编辑/删除/克隆」+「打开控制台」+
    「服务器状态」。
  - 新增 `RedisView` webview 骨架与 `'redis'` mode；实现 Status tab（INFO 分节）+ CLI 控制台 tab
    （命令输入/执行/结果格式化/只读拦截/危险命令 confirm/命令历史/耗时）+ SlowLog tab。
  - SSH 隧道 + TLS 可用。
  - i18n 基础词条；mechanical tests/commandRegistration/i18n 测试全绿。
  - **能跑通**：连本地 Redis → 打开控制台 → PING/SET/GET/INFO → 只读拦截 → FLUSHALL 弹确认。
- **S3 · 键树 + 五类型 viewer/editor + 新键/TTL + DB 节点**
  - 展开连接显示 DB 节点（INFO keyspace）；点 DB 打开 Redis 面板，传 connectionId+db。
  - 键树（SCAN 分页 + match + 刷新 + key 分隔符折叠 + 批量删除 + 大 key 提示）。
  - 五类型 viewer/editor（string/hash/list/set/zset）；string 的 text/JSON/hex 视图切换；TTL
    设置/查看；重命名/删除 key；新建 key 对话框。
  - CLI 控制台与值面板合并到同一 webview 三栏。
  - 单测：splitargs（引号/转义）、命令补全候选过滤、键名折叠算法。
  - **能跑通**：连接 Redis → DB0 浏览/新建/编辑/删除五种 key → TTL → 批量删除 → JSON 值编辑。
- **S4 · Cluster + Sentinel + SSH NAT map + Stream viewer + 体验增强**
  - Cluster 模式：`new Redis.Cluster` + slotsRefreshTimeout；键 scan/CRUD 在 cluster 下可用；
    禁用 DB 选择（cluster 无 SELECT）。
  - Sentinel 模式：sentinel 配置 + master 发现；故障切换事件日志。
  - SSH+Cluster / SSH+Sentinel NAT map：CLUSTER NODES/SENTINEL get-master-addr-by-name → 多隧道
    → natMap。
  - Stream viewer/editor（XRANGE/XADD/XDEL/XTRIM + XINFO GROUPS/CONSUMERS + XPENDING +
    XGROUP CREATE/DESTROY/DELCONSUMER）。
  - 快捷键（Ctrl+N/G/,/Enter）、命令日志面板、连接颜色标签、二进制 hex 编辑组件完善、
    分隔符虚拟滚动（应对百万级 key）、大 key 保护。
  - i18n 全部词条补齐；审计日志接入。
  - Docker 手动验证矩阵：standalone（无密码/密码/ACL/TLS/SSH/只读）、3 节点 cluster（直连/SSH）、
    sentinel（1m+1s）。

## 十、安全与隐私

- 密码、SSH 口令、Sentinel 节点密码 **只落 VS Code SecretStorage**，不落 Memento、不下发 webview、
  不写日志/错误栈。
- 证书/私钥路径落 Memento；文件内容由 Node 主进程读，不传给 webview；连接关闭后立即释放 Buffer。
- Webview CSP 保持 `default-src 'none'`，不开放 connect-src；所有 Redis 网络 I/O 在 extension host
  发起。
- 危险命令二次确认（UI 内 modal，不静默执行）；只读模式在 sendCommand 切面强制拦截，漏 UI
  判断也不会发出去。
- 命令日志只存本地（内存+历史文件），不上传服务器，不参与 P2 sync。
- 错误/日志中禁止打印密码、TLS 私钥内容、完整 keyspace dump。

## 十一、验证

### 自动化（必须全绿）

- `pnpm -r typecheck && pnpm -r lint && pnpm -r test`。
- db-core：RedisClient standalone 单测（ping/info/scan/CRUD/hash/list/set/zset/TTL/sendCommand
  切面只读拦截/命令日志事件/重试策略）；splitargs 单测；命令表分类单测。
- vscode-ext：commandRegistration 测试补 Redis 命令声明↔注册一致性；mechanicalGates 测试补
  "Redis 节点不暴露 SQL 命令"断言；i18n 键存在性/中英一致/占位符配对；baseWebViewReload 补 redis
  mode；webview 组件单测（RedisView 初始化、消息处理、viewer 切换）。
- 连接泄漏：S1/S2 单测断言 close 后 RedisClient 所有底层连接全部 quit。

### 手工验证矩阵（实施完回填 pass/fail）

| 项 | 场景 |
|---|---|
| 连接 | standalone 无密码 |
|  | standalone + 密码 |
|  | standalone + ACL username+password |
|  | standalone + TLS（自签 CA，勾选"允许自签名"） |
|  | standalone + SSH 隧道（私钥/口令两种） |
|  | 只读模式下写命令被拒 |
|  | Cluster 3 节点直连 |
|  | Cluster 3 节点 + SSH NAT map |
|  | Sentinel 1m+1s |
| 服务器 | INFO 分节完整展示 |
|  | SLOWLOG 列表 |
| CLI | PING/SET/GET/INFO 正常返回 |
|  | 命令历史上下翻 |
|  | 危险命令 FLUSHALL/FLUSHDB/SHUTDOWN/CONFIG/KEYS * 二次确认 |
|  | 只读模式下 SET 返回错误不发包 |
| 键浏览 | SCAN 分页加载 10w key 流畅 |
|  | match 过滤（前缀/通配） |
|  | 分隔符折叠展开 |
|  | 批量删除（带确认） |
|  | 大 key 提示+按需加载 |
| 值 CRUD | string text/JSON/hex 视图+编辑+保存 |
|  | hash 字段增删改、HSCAN 分页 |
|  | list push/pop/LSET/LREM/LTRIM |
|  | set SADD/SREM、SSCAN 分页 |
|  | zset ZADD/ZREM/ZINCRBY、score 分页 |
|  | stream XRANGE/XADD/XDEL/XTRIM、XINFO GROUPS |
|  | 新建 key（五类型） |
|  | TTL 查看/EXPIRE/PERSIST |
|  | 重命名/删除 key |
| 工程 | pnpm typecheck/lint/test 全绿 |
|  | webview 构建通过、bundle isolation 不引入 Redis 依赖到主线程 |
|  | SQL 三引擎现有全流程（MySQL/PG/SQLite）零回归 |
| i18n | 中英切换完整；无硬编码英文文案 |

## 十二、测试命令

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
pnpm -C apps/vscode-ext build:webview   # 确认 Redis 面板打入 bundle
```

手工矩阵需要本地 Docker 起 Redis 实例：

```bash
docker run -d --name redis -p 6379:6379 redis:7
docker run -d --name redis-tls ...        # 带 TLS 的 Redis（S4 时配置）
# cluster:
for p in 7001 7002 7003; do docker run -d -p $p:6379 redis:7 redis-server --cluster-enabled yes ...; done
redis-cli --cluster create 127.0.0.1:7001 127.0.0.1:7002 127.0.0.1:7003 --cluster-replicas 0
# sentinel: 略
```

## 十三、后续扩展（不在本阶段，提一句作为未来方向）

- Pub/Sub 订阅面板、MONITOR 实时流、RedisJSON/TimeSeries/Vector 等模块类型 viewer。
- 内存分析（MEMORY USAGE 采样 top-N 大键）、键导入导出、自定义 viewer（protobuf/msgpack/gzip/
  pickle 等可扩展解码脚本）。
- 个人同步（连接 + 分组 + 保存查询 + 保存控制台命令）跨设备 E2EE，作为 P2 v2 增量切片。
- 浏览器客户端（P9）复用 RedisClient 抽象，通过本地 sidecar WebSocket 桥接。
