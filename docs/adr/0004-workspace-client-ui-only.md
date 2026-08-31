# ADR-0004: Workspace 是客户端本地 UI 概念，服务端不提供 `/api/workspaces`

- 状态：Accepted
- 日期：2026-08-31

## 背景（Context）

V3 早期在 §5 路由表列了 `GET /api/workspaces`（认证，返回 Workspace 摘要），切片 1 落了一个占位实现 `{ personal: { kind: 'personal' }, organizations: [] }`。随后组织列表改由 `GET /api/organizations` 提供，扩展也实际使用后者组合 Workspace 选择器。此时 `/api/workspaces` 与 `/api/organizations` 形成同一份组织列表的两个来源，且 `WorkspaceRef` 类型（§2）迟迟没有进入 §5.1 DTO 清单，语义悬空。

## 决策（Decision）

**弃用 `/api/workspaces`，Workspace 收敛为客户端本地 UI 概念（非授权输入、非服务端 DTO）。**

1. 从 §5 路由表删除 `GET /api/workspaces`；§2 删除 `WorkspaceRef` 类型块。
2. `GET /api/organizations` 保留为组织集合 API 的唯一权威来源；Workspace 选择器的 Personal 侧来自 `GET /api/me`（用户 + 个人订阅），组织侧来自 `GET /api/organizations`。
3. 扩展内保留的 `WorkspaceRef` 为客户端本地类型，其 `role` 由 `/api/organizations` 的 role 派生、仅供展示，不做授权；服务端授权只认 URL 里的 `organizationId` + 静态 permission code。
4. 删除占位路由后，无新增表、迁移、错误码、权限或缓存语义。

## 理由（Rationale）

- **与 §2 一致**：Workspace 仅是客户端 UI 选择，不是授权输入；服务端职责边界止于「把数据源提供全」，而非替客户端聚合 Workspace。
- **数据无缺口，聚合路由冗余**：客户端选择器所需的两样（`/api/me` 的用户/权益、`/api/organizations` 的组织列表，含 role）都已具备，扩展已实际这样组合，弃用迁移成本为零。
- **避免双源漂移**：`/api/workspaces` 与 `/api/organizations` 若并存会各自维护一份组织列表 DTO，字段演进即漂移；弃用后组织列表只有单一权威来源。
- **类型张力**：§2 的 `WorkspaceRef` 是单选引用而非「可用 Workspace 摘要列表」；路由名与占位实现都缺少冻结语义——这正是它当初未进入 §5.1 DTO 清单的根因。

## 后果（Consequences）

- 正面：组织列表单源；Workspace 抽象与服务端授权边界清晰；无额外维护成本。
- 负面/成本：无。客户端需自行组合 Personal + 组织列表（扩展已如此实现）。
- 若未来要真正的「跨个人/多组织统一消息流」，应在专项设计中重新冻结 Workspace 语义，而非复用本占位路由。

## 关联

- [V3 实施规格](../v3/实施规格.md) §2（第 5 条边界、类型块）、§5（路由表）。