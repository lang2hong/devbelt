# ADR-0006: 个人 E2E 同步 V1 实施准入与切片计划

- 状态：Accepted
- 日期：2026-09-01

## 背景（Context）

`docs/v3/实施规格.md` §8.1 将「个人 E2E 同步 V1」冻结为专项契约，但按 §6.5 要求，实施前须通过准入复核并完成单独 L2/L3 实施规划，且每个切片评审提交须列出变更文件、测试输出与未覆盖验收项。此前 S1–S4 已落码提交、S5 正在工作区开发，但仓库缺少正式的准入结论与切片计划记录，导致规格状态行与实际交付脱节（评审结论 P0-1）。

## 决策（Decision）

1. **准入结论**：以 2026-09-01 的专项评审为准入复核，结论为**有条件通过**。评审以 `docs/v3/实施规格.md` §8.1 为唯一权威，确认服务端零明文/零可派生密钥红线守住、u64 全程十进制字符串、签名先于 nonce 落账、receipt 过期后走全量重校验、destroy/reset change_sequence 跨 epoch 连续、migration 顺序与 §8.1.12 一致。

   **准入条件与解除方式**：
   - 条件 A（修复批，本批解除）：协议契约偏差 #1–#6 修正、三处裁定行为测试锚定、receipt fail-closed、换行补齐、签名路由 smoke 与同步并发真库测试。
   - 条件 B（CI 真库证据，待 push 解除）：push 后由 CI 真库集成门禁（含新增 `syncConcurrency.test.ts` / `syncReset.test.ts`）跑过，把结果回填本文「测试输出」栏；回填后准入才闭环。
2. **切片计划（L2/L3）**：按以下纵向切片交付，前一切片评审通过后方可依赖其行为：

| 切片 | 范围 | 状态 |
|---|---|---|
| S1 | `personal_sync_*` 数据层 migration + 注册快照两列 | 已合并 `7b22c67` |
| S2 | 仓储层 + 注册快照透传 | 已合并 `d39bae7` |
| S3 | 状态服务与路由（state/init/change-key/recover/destroy） | 已合并 `332a290` |
| S4 | record feed 与配额（pull/put/delete + 配额） | 已合并 `b9b4e57` + `895c7ba` |
| S5 | reset-after-loss 邮箱挑战协议 | 本批合并 |

3. **三处规格空白裁定**（§6.5 澄清记录，已写回 `docs/v3/实施规格.md` §8.1）：
   - reset-after-loss 无 active state → 等价建 `keyEpoch=1` 新 epoch（不返回 `SYNC_NOT_INITIALIZED`）。
   - tombstone 上的 record 变更（update/delete/create）→ 统一 `409 SYNC_VERSION_CONFLICT`（`currentVersion`=tombstone 版本）；record 从未存在仍 `404 NOT_FOUND`。
   - `SYNC_QUOTA_EXCEEDED` 响应体 `used` = 当前已用量（写入前 count/bytes），非写入后预计值。
4. **范围边界**：S1–S5 为**纯服务端**切片。§8.1.6 的扩展端强制点（`PersonalEntitlement` 依据 subscription snapshot 在连接创建/编辑/导入/解密后强制 `allowedDatabaseTypes`）与 V3 同步客户端接入**不在本批**，须另立 L2/L3 计划后再实施。

## 各切片评审证据（变更文件 / 测试 / 未覆盖）

- **S1** `7b22c67`：变更 `009_personal_sync.ts`、`migrations/index.ts`；测试 `test/integration/migration.test.ts`。未覆盖：既有 Phase 1 数据的回填 smoke 仅真库（CI）验证。
- **S2** `d39bae7`：变更 `entities.ts`/`enums.ts`/`interfaces.ts` + 六个 mysql sync 仓储 + `fakeRepos.ts`；测试 `test/integration/syncRepo.test.ts`。未覆盖：并发语义（fake 无行锁）。
- **S3** `332a290`：变更 `syncU64.ts`/`syncCrypto.ts`/`syncStateService.ts`/`sync.ts`/`schemas.ts` + `errorHandler.ts`；测试 `syncCrypto.test.ts`/`syncStateService.test.ts`/`sync.route.test.ts`。未覆盖：签名路由 HTTP 层 smoke（本次补）。
- **S4** `b9b4e57` + `895c7ba`：变更 `syncRecordService.ts`/`syncShared.ts`；测试 `syncRecordService.test.ts`。未覆盖：并发 putRecord/destroy 真库（本次补）。
- **S5**（本批）：变更 `syncResetService.ts`/`emailSender.ts`/`smtpEmailSender.ts`/`schemas.ts`/`sync.ts`/`app.ts`；测试 `syncResetService.test.ts`/`sync.route.test.ts`/`syncReset.test.ts`（集成）。

## 理由（Rationale）

- 治理先行：让「规格是唯一实施权威」可被验证，而非以代码提交代替准入审批。
- 纵向切片：每片可独立评审、可独立随迁证明，符合 §6.5「一个切片通过评审前不得依赖其未验证行为」。

## 后果（Consequences）

- `docs/v3/README.md`、`docs/v3/实施规格.md` §8 状态行、`packages/server/README.md`、`packages/vscode-ext/README.md` 与「实施中」阶段对齐。
- 后续切片（若继续）仍须在开工前补齐该切片的 L2/L3 计划与评审提交。

## 关联

- [V3 实施规格](../v3/实施规格.md) §8.1（冻结契约）、§6.5（切片评审）。
- [ADR-0005](./0005-concurrency-and-locking.md)（并发锁）——同步域沿用其「配额锁内计量」原则。