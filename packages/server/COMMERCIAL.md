# 套餐与商业化规划

> 本文记录套餐配额维度、Feature 位体系与商业化分层策略，以及尚未落地的远期计划。
> 代码层面的单点真源：客户端 `packages/vscode-ext/src/sync/features.ts`、服务端 `packages/server/src/domain/enums.ts`、`schema.ts` 的 `PLAN_SEED`。

## 一、Feature 位体系（`features` 位掩码）

每个功能占一个二进制位，值取 2 的幂。客户端按位与判断可用性（`requireFeature`）。

| 位值 | 名称 | 状态 |
|---|---|---|
| 1 | basic | 已启用（free 也含） |
| 2 | er_export（ER 图导出） | 已启用，客户端已门控 |
| 4 | excel（Excel 导入导出） | 已启用，客户端已门控 |
| 8 | datatransfer（库间数据传输） | 已启用，客户端已门控 |
| 16 | team_share（团队共享） | **预留：客户端未实现对应功能** |
| 32 | audit_log（审计日志） | 已启用（服务端语义），客户端本地审计面板未收费 |
| 64 | export_connections（导出连接配置） | 已启用，客户端已门控 |
| 128 | schedule_backup（定时备份） | **预留：未实现** |

- 套餐 `features` 值（与 `PLAN_SEED` 对齐）：free=1，pro=`0b1000111`=71，team=`0b1111111`=127。
- 新增功能位时，同步改三处：客户端 `features.ts`、服务端 `enums.ts`（`1 << n`）、admin-ui `format.ts` 的 `FEATURES`。

## 二、套餐配额维度（`plans` 表）

| 字段 | 含义 | free / pro / team |
|---|---|---|
| max_devices | 设备数 | 1 / 5 / 20 |
| max_connections | 保存连接数 | 20 / 200 / 500 |
| max_open_connections | 同时打开连接数（0=无限） | 2 / 0 / 0 |
| sync_quota_bytes | 同步容量 | 1MB / 100MB / 1GB |
| sync_version_retention | 同步历史版本保留数 | 3 / 30 / 90 |
| history_retention_count | 查询历史保留条数（0=无限） | 50 / 0 / 0 |
| features | 功能位掩码 | 1 / 71 / 127 |

- 所有 `max_*` 字段语义：`0 = 无限`。
- 配额在服务端 enforce（同步时校验 `maxConnections`、`maxDevices`、`syncQuotaBytes`）。

## 三、商业化分层策略

**原则：本地基础能力放开，付费扳机放在功能位、云同步容量、设备数上，不在连接数上抠。**

1. 连接数是最不该当付费钩子的维度——竞品 DBeaver 本地版免费且连接数无限，卡连接数等于劝退。
2. 真正让人付费的三类扳机（按转化力）：
   - **功能位**（ER 导出 / Excel / 数据迁移 / 导出连接 / 审计）——「干活绕不开」。
   - **云同步容量 + 设备数**——多设备、多备份的刚需。
   - **团队共享 / 审计**——面向团队 B 端。
3. 未登录用户在客户端**不限制本地连接数**（未登录无套餐，`requireFeature` 直接拦截付费能力并引导登录）。

## 四、远期计划（尚未落地）

1. **本地保存连接数限制**（未登录 / free 的硬限制）——当前未启用；若做，参考「未登录不限、free=20」。
2. **同时打开连接数分层**——`max_open_connections` 字段已加、已可后台配置，但客户端 `connectionManager` 尚未按套餐动态限制（当前统一本地池上限 10）；落地时按「未登录 1 / free 2 / pro·team 无限」。
3. **team_share 功能本体**——只有位定义，客户端与服务端均未实现团队共享。
4. **购买 / 订阅流程**——服务端只有 `PaymentProvider` 类型（manual/stripe/lemonsqueezy），无支付实现；客户端 `AccountView` 已展示套餐/用量/订阅状态，但「升级」目前无跳转目标（需先有订阅页）。
5. **命令门控**——付费能力命令的 `when` 门控随功能位逐步补；基础云能力（sessions/account/changeSyncPassword）已按 `dbclient.loggedIn` 控制。

## 五、生产环境迁移要点

- `plans` 表加列 `max_open_connections` 由 `schema.ts` 的 `addColumnIfMissing` 幂等完成（服务启动时自动）。
- 但 `PLAN_SEED` 的 `ON DUPLICATE KEY UPDATE code = code` **不覆盖已存在套餐**，种子值调整对新库生效、对已上线库需手工 `UPDATE plans SET ...`。