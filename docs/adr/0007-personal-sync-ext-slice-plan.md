# ADR-0007: 个人 E2E 同步 V1 扩展端切片计划（连接门禁 + V3 客户端接入拆分）

- 状态：Accepted
- 日期：2026-09-01

## 背景（Context）

ADR-0006 闭环了服务端 S1–S5（个人 E2E 同步 V1 数据层/仓储/状态与记录/配额/reset-after-loss），并把两块**扩展端**工作划出边界、须另立 L2/L3 计划：

1. §8.1.6 的连接许可证门禁：ext `PersonalEntitlement` 依 snapshot 在连接创建/编辑/导入/连接/解密后使用处强制 `allowedDatabaseTypes`（服务端不查密文内 databaseType）。
2. V3 同步协议客户端接入：ext 尚未接入 §8.1 的 records/state/init/change-key/recover/destroy/reset-after-loss 协议。

本 ADR 记录这两块的切片划分、裁定与依赖顺序；裁定已写回 `docs/v3/实施规格.md` §8.1.6。

## 决策（Decision）

### 切片 A：个人连接许可证门禁（allowedDatabaseTypes）

范围小、可独立闭环、无可服务端改动。核心裁定（详见 §8.1.6）：

- **权益轴 fail-open**：无 `CachedEntitlement`（未登录/登出已清缓存）→ 直接放行、不比对 `allowedDatabaseTypes`；个人连接本地优先，离线/首次启动不阻断本地 PostgreSQL。有缓存直接用缓存值、不强制实时校验；权益仅在登录 `/api/me` 时点刷新。
- **引擎轴 fail-closed**：映射 `MYSQL→mysql` / `PG→postgresql` / `SQLITE→sqlite` 三条；未知 `DatabaseType` 一律拒绝。
- **仅门禁个人连接**：`ConnectionManager` 是个人+组织共用的建连入口（组织模板 `commands/org.ts` 经同一 `manager.connect`），门禁落点须先判定归属；组织连接走 organization 模板权益口径。
- **五个使用点**：建连兜底点（`doConnect`，覆盖全部 `manager.connect`）、表单 `save`/`test`、连接导入、同步解密后应用。
- **解密后=逐条跳过 + 汇总上报**：同步 pull 应用远端连接时违规引擎逐条跳过、收集清单、一次性提示，绝不整批失败、不删本地连接。
- **删除永不门禁**：墓碑（`deleted=true`）原样保留以传播删除语义。
- **编辑按变更后目标引擎断言**（同一 `assertPersonalDatabaseType`）。

### 切片 B：V3 同步客户端接入（拆分，逐片独立 L2/L3）

范围大且涉及替换现有 V2 分节同步，按下表分子切片，前一片评审通过后方可依赖其行为：

| 子切片 | 范围 | 依赖 |
|---|---|---|
| B1 密钥层 | DEK 生成、`syncSignPriv`/`recoverSignPriv` HKDF 派生、`KEK_smp`(Argon2id)/`KEK_recovery`(HKDF)、envelope 每版专用 AEAD key、AES-256-GCM 加解密、恢复码熵与持久化（§8.1.2/8.1.3） | 无 |
| B2 协议层 | `SyncClient` 增 11 个 V3 方法；JCS canonicalize(RFC8785)；Ed25519 签名 + `requestDigest`；`SignedMutation`/envelope 编码（§8.1.7/8.1.8/8.1.9） | B1 |
| B3 状态机 | 本地 keyEpoch/stateVersion/change_sequence/nonce 防重；密文 record 持久化与本地连接映射（§8.1.4） | B2 |
| B4 UI 命令 | init / change-key / recover / destroy / reset-after-loss 命令与恢复码展示 | B3 |
| B5 迁移 | V2 分节同步（`/api/sync` 分节 push/pull/versions/rollback + 主密码 AES-GCM）→ V3 record 的存量数据迁移与并存期策略 | B3 |

## 未决问题（切片 B 开工前须裁定，不得实现时自行决定）

1. V2→V3 迁移策略：一次性迁移、双写过渡，还是新用户 V3 / 老用户继续 V2（B5 的核心）。
2. 客户端密钥/状态持久化位置：DEK/签名私钥/恢复码/epoch/未消费 nonce 各落在 `SecretStorage` 还是 `globalState`，以及弱网/离线下的可用性边界。
3. `SavedConnection`（含明文 DB 凭据）到 §8.1 record 密文的映射：一 record 一连接？payload 结构？`recordId` 与本地 `connection.id` 如何对应。
4. V3 与 V2 并存期的 UI 语言（sync 面板如何解释两套协议），以及与切片 A 解密后门禁的衔接。

## 理由（Rationale）

- 切片 A 是 §8.1.6 已冻结契约的直接落地，且服务端权益透传已就绪（`/api/me` 已在 ext 侧有 `CachedEntitlement` 但无人消费），可独立、低风险推进。
- 切片 B 是替换级专项，先拆子切片、逐片评审，避免一次性大改导致 V2 同步瘫掉或被 V3 半成品覆盖。

## 后果（Consequences）

- 切片 A 完成后，个人连接在 ext 端即受权益约束，与服务端匿名 Free 口径一致。
- 切片 B 每个子切片开工前仍须补充该片的 L2/L3 计划与评审提交；未决问题 1–4 未决前不得落 B3/B5 代码。

## 关联

- [V3 实施规格](../v3/实施规格.md) §8.1（冻结契约）、§8.1.6（扩展端门禁裁定）。
- [ADR-0006](./0006-personal-sync-slice-plan.md)（服务端 S1–S5 准入与闭环）。
- [ADR-0005](./0005-concurrency-and-locking.md)（并发锁——同步域沿用其原则）。