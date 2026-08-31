# ADR-0005: V3 并发控制与统一锁协议

- 状态：Accepted
- 日期：2026-08-31

## 背景（Context）

组织域有多个并发写入口（邀请/接受/撤销、成员移除/退出/分配角色、关闭组织、目录移动/删除、资源创建/更新/删除），且容量（`seat_limit`）和资源配额都按订阅快照在多行上计量。若无统一锁序与显式的资源版本并发控制，会引入死锁与 last-write-wins 覆写。

## 决策（Decision）

1. **统一锁序（DB 行锁）**：所有组织写事务按 `organization → subscription → membership → invitation` 加锁；目录/资源写事务在 `organization → subscription` 之后加 `folder → resource`（folder 先于 resource）。会话域（个人）按 `user → device → refresh_token` 加锁。锁序在全仓统一，禁止在业务处理器中散落自定义顺序。
2. **资源乐观锁**：更新资源以 `WHERE id=? AND organization_id=? AND version=? AND delete_time IS NULL` 生效；受影响行数为 0 即版本已变，读取当前版本并抛 `ResourceVersionConflictError(currentVersion)`。
3. **版本冲突响应**：`409 RESOURCE_VERSION_CONFLICT`，响应体回传 `{code, currentVersion}`，供客户端提示/重载；不得 last-write-wins。
4. **配额在锁内计量**：创建/更新在同一事务内按 UTF-8 序列化后的 content 字节数、资源数量与当前订阅快照强制组织配额；超额返回 `409 ORGANIZATION_QUOTA_EXCEEDED`。
5. **目录移动环拒绝**：在同一事务锁定被移动目录、新父目录及其祖先链（§4.3），拒绝 `parentId=folderId` 及新父属于被移动目录后代，返回 `409 FOLDER_MOVE_CYCLE`；目录不隐式级联删除，含未删除子目录或资源时返回 `409 FOLDER_NOT_EMPTY`。

## 理由（Rationale）

- **死锁避免**：固定全局锁序让并发事务按同一顺序抢行锁，避免循环等待。
- **可恢复的冲突**：乐观锁 + `currentVersion` 回传让客户端拿到权威版本后决定覆盖/合并，而非服务端静默丢写。
- **配额一致**：配额与写操作同事务、锁内计量，避免并发插边越过上限。

## 后果（Consequences）

- 组织写操作全部经过 shared guard + 统一事务边界；新仓储方法须 `ForUpdate` 语义并遵循锁序。
- 客户端须处理 `RESOURCE_VERSION_CONFLICT` 并回读 `currentVersion`；扩展缓存对 409 保留本地编辑供冲突处理，不驱逐（§6.2）。
- 任何新增并发写入口都必须先在规格 §4.3/§8 冻结其锁序与冲突语义后实现。

## 关联

- [V3 实施规格](../v3/实施规格.md) §4.3、§5（统一错误）、§6.2。
- [ADR-0003](./0003-v3-authorization-model.md)（授权 middleware 与 404 隐藏语义）。