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

- **fail-closed 默认 Free**：无 `CachedEntitlement`（未登录/登出已清缓存）→ `DEFAULT_FREE=['mysql','sqlite']` 兜底；仅 `postgresql` 被拒并引导登录/升级。有缓存直接用缓存值、不强制实时校验；权益仅在登录 `/api/me` 时点刷新。
- **映射表 fail-closed**：`MYSQL→mysql` / `PG→postgresql` / `SQLITE→sqlite` 三条；未知 `DatabaseType` 一律拒绝。
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
| B2 协议层 | 新增独立 V3 客户端（10 个路由方法，5 个需签名）；JCS（镜像服务端 `syncCrypto.jcs`）；Ed25519 签名 + `requestDigest`；`SignedMutation`/envelope 编码（§8.1.7/8.1.8/8.1.9） | B1 |
| B3a 协议本地原语 | 本地 state 快照（`dbclient.sync.v3.state.<userId>`，u64 单调防回退）、`recordAad`（purpose='record'）、白名单 record 编解码、record 解密 helper（§8.1.4/8.1.8） | B2 |
| B3b record 映射与状态机编排 | record ↔ SavedConnection 双向映射、tombstone 删除、epoch 清理；mutation 生命周期（生成/提交/版本推进/冲突对齐/feed 续拉）（§8.1.4/8.1.9） | B3a |
| B4 UI 命令 | init / change-key / recover / destroy / reset-after-loss 命令与恢复码展示、SMP 解锁 worker | B3b |
| B5 迁移 | V2 分节同步（`/api/sync` 分节 push/pull/versions/rollback + 主密码 AES-GCM）→ V3 record 的存量数据迁移与并存期策略 | B3 |

## 未决问题（切片 B 开工前须裁定，不得实现时自行决定）

1. V2→V3 迁移策略：一次性迁移、双写过渡，还是新用户 V3 / 老用户继续 V2（B5 的核心）。
2. 客户端密钥/状态持久化位置：DEK/签名私钥/恢复码/epoch/未消费 nonce 各落在 `SecretStorage` 还是 `globalState`，以及弱网/离线下的可用性边界。**（B1 子集已裁定，2026-09-01）**：DEK 仅 SecretStorage、key 按 `dbclient.sync.dek.v1.<userId>.<keyEpoch>` 账户+epoch 隔离；`syncSignPriv`/`recoverSignPriv`/SMP/恢复码均不自动落盘（即时派生或用户保管）；公开件与 envelope 密文落 globalState。**B3a 子集已裁定**：globalState 状态机（keyEpoch/stateVersion/change_sequence）按 `userId` 隔离。**nonce 子项已裁定关闭（2026-09-01）**：客户端不持久化 nonce ledger；每次 mutation 用随机 12B nonce（同 key 碰撞生日界可忽略），服务端 `personal_sync_nonces` + mutation receipt 幂等兜底；失败重试同一 mutation 必须原样复用 nonce/mutationId/body/signature。
3. `SavedConnection`（含明文 DB 凭据）到 §8.1 record 密文的映射。**（已裁定草案归 B3b，2026-09-01）**：一 record 一连接；recordId 为 CSPRNG 16B → 22 字符无 padding base64url，不复用 `connection.id`；映射按 userId+keyEpoch 双向（`recordId ↔ connectionId`）；远端新 record 生成新 `connectionId`、tombstone 删除映射与本地连接、组织连接永不入映射、未映射 tombstone 不建连接不报错；epoch 清理仅在服务端状态确认且本地应用完成后。
4. V3 与 V2 并存期的 UI 语言（sync 面板如何解释两套协议），以及与切片 A 解密后门禁的衔接。

## 理由（Rationale）

- 切片 A 是 §8.1.6 已冻结契约的直接落地，且服务端权益透传已就绪（`/api/me` 已在 ext 侧有 `CachedEntitlement` 但无人消费），可独立、低风险推进。
- 切片 B 是替换级专项，先拆子切片、逐片评审，避免一次性大改导致 V2 同步瘫掉或被 V3 半成品覆盖。

## 后果（Consequences）

- 切片 A 完成后，个人连接在 ext 端即受权益约束，与服务端匿名 Free 口径一致。
- 切片 B 每个子切片开工前仍须补充该片的 L2/L3 计划与评审提交；未决 #1（迁移）归 B5、#4（并存期 UI）归 B4，未决前不得落相应代码。
- 编排归属：mutation 生命周期与 feed 续拉归 B3（B3b 一并交付），B4 为纯 UI 命令 + SMP 解锁入口，不做编排。
- dbPath 剔除后果（B4 UI 义务）：拉回的 SQLite 连接无文件路径，设备 B 须由用户补数据库路径后方可连接；recordCodec 注释与 B4 规划须据此记录。

## 关联

- [V3 实施规格](../v3/实施规格.md) §8.1（冻结契约）、§8.1.6（扩展端门禁裁定）。
- [ADR-0006](./0006-personal-sync-slice-plan.md)（服务端 S1–S5 准入与闭环）。
- [ADR-0005](./0005-concurrency-and-locking.md)（并发锁——同步域沿用其原则）。