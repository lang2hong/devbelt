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
| ~~B5 迁移~~ | ~~V2 分节同步 → V3 record 迁移~~ **已取消（2026-09-01）**：无迁移、无 fallback、无并存，V2 客户端直接删除 | 已取消 |

## 未决问题（切片 B 开工前须裁定，不得实现时自行决定）

1. ~~V2→V3 迁移策略~~ **已取消（2026-09-01）**：实施规格 §6.5 Greenfield 原则规定不迁移、无双写、无 fallback；V2 分节同步客户端（SyncManager/encryption/masterPasswordStore/autoSyncService/mergePlan/同步命令）已整体删除，不保留迁移或并存。
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

## B3b 冻结裁定（2026-09-01）

1. **本地脏冲突**：V3 的权威并发版本是服务端 `record.version`，本机时钟不决定胜负；不允许静默远端覆盖。若本地连接自该 record 最后成功应用/确认后发生变更，且 pull 到更高远端 version（含 tombstone）→ 停止在该 record、保留本地连接与当前 cursor、不覆盖不删除，抛不含秘密的 `V3RecordConflictError`，冲突解决 UI 归 B4。若远端 version == 已确认 version，本地变更作为待推送 mutation，不被 pull 覆盖。B4 项为脏状态展示与防御纵深（冲突检测已用 revision 标记挡住覆盖风险）。
2. **connectionId**：复用 `uniqueId('c')`（本地 UI 标识，非密码学标识）；生成后必须确认无同 ID，碰撞即重生成。`recordId` 仍为 CSPRNG 16B → 22 字符无 padding base64url，不复用 connectionId。
3. **apply 幂等**：`RecordMapStore` 持久化 `recordId + connectionId + 服务端确认 recordVersion + 本地连接 revision 标记(updateTime)`；收到 version ≤ 已确认 version 不重复写，更高 version 才进冲突检查/远端应用；tombstone 按 version 判断。
4. **epoch 清理时序**：不等待下一次 pull。destroy/reset 或发现远端已切 epoch → ①服务端成功确认 → ②GET state 确认新 epoch → ③持久化新 snapshot → ④清旧 epoch record map / pending outbox / 游标 → ⑤删旧 epoch DEK。新 DEK 在发起需要它的新 epoch 请求前入 SecretStorage；服务端成功但本地 ②-⑤ 失败不回滚服务端，保留新旧 DEK 与可重放清理标记，启动时 `reconcileEpochTransition()` 对账恢复。UI 命令/确认归 B4，不在此接线。
5. **V2 并存期隔离**：区分事件用途——UI/树刷新收全部连接变更；V2 `AutoSyncService` 仅收用户/V2 来源变更，忽略 `source: 'v3-sync'`。B3b 纳入 ConnectionStore/extension.ts/autoSync 测试；V3 engine 本批不注册为自动监听器。

**B3b 新增范围（超出原 Scope Lock）**：
- `PendingMutationStore`（outbox，按 userId+keyEpoch 隔离）：持久化完整已签名 record mutation——`action/recordId/connectionId/baseVersion/mutationId/nonce/ciphertext/tag/signature/requestDigest`；不存明文连接/DEK/SMP/私钥。请求发出前先落盘；重放必须用完全相同 mutationId/nonce/ciphertext/digest/signature；服务端成功后先更新 mapping/state 再删 outbox 条目。
- `syncEngine` 固定顺序：epoch 对账 → 重放 outbox → 推送明确提交的本地 mutation → feed 续拉 → 安全应用远端 → 最后推进 changeSequence cursor。`changeSequence` 只存服务端/ pull 确认值，绝不客户端猜测递增。冲突 → 从服务端重拉快照对齐 → 上报调用方，不得无限静默自旋。
- **recordCodec 约束**：`sqliteCommand`、`connectionUrl`/`useConnectionString` 不进白名单（fail-closed，返回不含 URL 内容/秘密的可诊断错误）；`sshPrivateKeyPath`/`dbPath`/`id`/时间戳/`deleted` 与未知字段拒绝；`password`/`sshPassword`/`sshPassphrase` 仅在白名单密文字段处理，永不进日志/map/state/outbox 明文。
- **跨存储失败边界**：ConnectionStore 与 Memento 不能原子提交，按可重放顺序 + 失败注入测试：新 active 先写 map 预留 connectionId 再写连接最后确认 version/cursor（中断复用同一本地 ID）；tombstone 先删连接再删 map 最后推进 cursor（中断保留 map）。每步失败不得产生第二条连接或 cursor 越过未应用 record。

## 关联

- [V3 实施规格](../v3/实施规格.md) §8.1（冻结契约）、§8.1.6（扩展端门禁裁定）。
- [ADR-0006](./0006-personal-sync-slice-plan.md)（服务端 S1–S5 准入与闭环）。
- [ADR-0005](./0005-concurrency-and-locking.md)（并发锁——同步域沿用其原则）。